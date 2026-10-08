// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 partialHuman

// Spotify Web API helpers shared by the extension (playlist list) and the preferences (login).
// Uses the Authorization Code + PKCE flow, so no client secret is needed – only the Client ID of a
// Spotify app that the user creates on developer.spotify.com.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Promise wrapper (avoids patching Soup's prototype at import time)
function sendAndRead(session, msg) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (src, res) => {
            try {
                resolve(src.send_and_read_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export const REDIRECT_PORT = 8898;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
export const SCOPES = 'playlist-read-private playlist-read-collaborative';

const AUTH_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'music-flyout', 'spotify.json']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'music-flyout']);
const PLAYLIST_CACHE = GLib.build_filenamev([CACHE_DIR, 'playlists.json']);

// ------------------------------------------------------------------ files
function readJson(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch (e) {
        return null;
    }
}

function writeJson(path, obj, mode) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents_full(path, new TextEncoder().encode(JSON.stringify(obj)),
        GLib.FileSetContentsFlags.CONSISTENT, mode);
}

export function loadAuth() {
    const a = readJson(AUTH_FILE);
    return a?.refresh_token ? a : null;
}

function saveAuth(auth) {
    writeJson(AUTH_FILE, auth, 0o600);          // holds a refresh token: owner-only
}

export function clearAuth() {
    try { Gio.File.new_for_path(AUTH_FILE).delete(null); } catch (e) { /* already gone */ }
}

export function loadPlaylistCache() {
    const c = readJson(PLAYLIST_CACHE);
    return Array.isArray(c) ? c : null;
}

export function savePlaylistCache(items) {
    try { writeJson(PLAYLIST_CACHE, items, 0o644); } catch (e) { /* cache is optional */ }
}

// ------------------------------------------------------------------- PKCE
function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    const bytes = stream.read_bytes(length, null).get_data();
    stream.close(null);
    let s = '';
    for (const b of bytes) s += chars[b % chars.length];
    return s;
}

export function newVerifier() { return randomString(64); }
export function newState() { return randomString(16); }

export function challengeFor(verifier) {
    const sum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    sum.update(new TextEncoder().encode(verifier));
    const raw = new Uint8Array(sum.get_string().match(/../g).map(h => parseInt(h, 16)));
    return GLib.base64_encode(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function authorizeUrl(clientId, challenge, state) {
    const q = {
        response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: REDIRECT_URI,
        state, code_challenge_method: 'S256', code_challenge: challenge,
    };
    return `https://accounts.spotify.com/authorize?${encode(q)}`;
}

// ------------------------------------------------------------------- HTTP
function encode(obj) {
    return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function request(session, method, url, {headers = {}, form = null} = {}) {
    const msg = form
        ? Soup.Message.new_from_encoded_form(method, url, encode(form))
        : Soup.Message.new(method, url);
    if (!msg) throw new Error('bad request');
    for (const [k, v] of Object.entries(headers))
        msg.get_request_headers().append(k, v);
    const bytes = await sendAndRead(session, msg);
    const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return {status: msg.get_status(), json};
}

export async function download(session, url, path) {
    const msg = Soup.Message.new('GET', url);
    if (!msg) return false;
    const bytes = await sendAndRead(session, msg);
    if (msg.get_status() !== Soup.Status.OK) return false;
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, bytes.get_data());
    return true;
}

// ------------------------------------------------------------------ tokens
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

function storeTokens(clientId, json, previous) {
    saveAuth({
        client_id: clientId,
        refresh_token: json.refresh_token ?? previous?.refresh_token,
        access_token: json.access_token,
        expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
    });
}

export async function exchangeCode(session, clientId, code, verifier) {
    const r = await request(session, 'POST', TOKEN_URL, {
        form: {grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
            client_id: clientId, code_verifier: verifier},
    });
    if (r.status !== 200 || !r.json?.access_token)
        throw new Error(r.json?.error_description ?? `HTTP ${r.status}`);
    storeTokens(clientId, r.json, null);
}

async function accessToken(session) {
    const auth = loadAuth();
    if (!auth) throw new Error('auth');
    if (auth.access_token && auth.expires_at - 60 > Date.now() / 1000)
        return auth.access_token;

    const r = await request(session, 'POST', TOKEN_URL, {
        form: {grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id},
    });
    if (r.status === 400 || r.status === 401) {       // revoked / expired for good
        clearAuth();
        throw new Error('auth');
    }
    if (r.status !== 200 || !r.json?.access_token)
        throw new Error(`token refresh failed (HTTP ${r.status})`);
    storeTokens(auth.client_id, r.json, auth);
    return r.json.access_token;
}

// --------------------------------------------------------------- playlists
function pickImage(images) {
    if (!Array.isArray(images) || images.length === 0) return null;
    // smallest image that is still at least 64px wide (images are usually listed largest first)
    const sized = images.filter(i => i?.url).sort((a, b) => (a.width ?? 9999) - (b.width ?? 9999));
    return (sized.find(i => (i.width ?? 9999) >= 64) ?? sized[sized.length - 1])?.url ?? null;
}

export async function fetchPlaylists(session) {
    const token = await accessToken(session);
    const headers = {Authorization: `Bearer ${token}`};
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    const out = [];

    for (let page = 0; url && page < 60; page++) {
        const r = await request(session, 'GET', url, {headers});
        if (r.status === 400 && url.includes('limit=50')) {   // lower page-size cap: retry with 10
            url = url.replace('limit=50', 'limit=10');
            continue;
        }
        if (r.status === 401) throw new Error('auth');
        if (r.status === 403) throw new Error('403 – is your Spotify account added to the app\'s users?');
        if (r.status === 429) throw new Error('rate limited, try again later');
        if (r.status !== 200 || !r.json) throw new Error(`HTTP ${r.status}`);

        for (const p of r.json.items ?? []) {
            if (!p?.id) continue;
            out.push({
                id: p.id,
                uri: p.uri ?? `spotify:playlist:${p.id}`,
                name: p.name ?? '(untitled)',
                owner: p.owner?.display_name ?? '',
                total: p.items?.total ?? p.tracks?.total ?? null,
                image: pickImage(p.images),
            });
        }
        url = r.json.next ?? null;
    }
    return out;
}
