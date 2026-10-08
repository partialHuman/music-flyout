UUID  := music-flyout@partialHuman
DEST  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := extension.js prefs.js spotify.js stylesheet.css metadata.json LICENSE \
         schemas/org.gnome.shell.extensions.music-flyout.gschema.xml

.PHONY: zip install uninstall clean

# Zip for extensions.gnome.org / GitHub releases (only the files the extension needs)
zip:
	rm -f $(UUID).zip
	zip $(UUID).zip $(FILES)
	@echo "Built $(UUID).zip"

# Copy into your user extensions directory (log out and in afterwards on Wayland)
install:
	mkdir -p $(DEST)
	cp --parents $(FILES) $(DEST)
	glib-compile-schemas $(DEST)/schemas
	@echo "Installed to $(DEST)"

uninstall:
	rm -rf $(DEST)

clean:
	rm -f $(UUID).zip
