UUID := $(shell python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := extension.js prefs.js spotify.js stylesheet.css metadata.json LICENSE \
         schemas/org.gnome.shell.extensions.music-flyout.gschema.xml
ICON_FILES := $(shell find icons -type f)

.PHONY: zip install uninstall clean

zip:
	rm -f $(UUID).zip
	zip $(UUID).zip $(FILES) $(ICON_FILES)
	@echo "Built $(UUID).zip"

install:
	mkdir -p $(DEST)
	cp --parents $(FILES) $(ICON_FILES) $(DEST)
	glib-compile-schemas $(DEST)/schemas
	@echo "Installed to $(DEST)"
	@echo "On Wayland, log out and back in before enabling/reloading."

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf -- $(DEST)
	@echo "Removed $(UUID)"

clean:
	rm -f $(UUID).zip
