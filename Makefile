UUID = gdi@gnome.desktop.intelligence
BUILD_DIR = build
DATA_DIR = $(if $(XDG_DATA_HOME),$(XDG_DATA_HOME),$(HOME)/.local/share)
EXTENSION_DIR = $(DATA_DIR)/gnome-shell/extensions/$(UUID)

.PHONY: all schema lint pack clean install install-service uninstall test-passive

all: schema pack

schema:
	glib-compile-schemas --strict schemas

lint: schema
	python3 -c 'from pathlib import Path; paths = list(Path("service").rglob("*.py")) + list(Path("tools").glob("*.py")); [compile(path.read_text(), str(path), "exec") for path in paths]'
	find . -path './build' -prune -o -name '*.js' -type f \
		-exec sh -c 'node --input-type=module --check < "$$1"' _ {} \;

pack: schema
	find service -type d -name __pycache__ -prune -exec rm -rf {} +
	mkdir -p $(BUILD_DIR)
	gnome-extensions pack --force --schema=schemas/org.gnome.shell.extensions.gdi.gschema.xml \
		--extra-source=palette.js --extra-source=src --extra-source=service --extra-source=icons \
		--extra-source=LICENSE --extra-source=NOTICE.md \
		--out-dir $(BUILD_DIR) .
	# GNOME 46 pack deliberately omits compiled schemas, even as extra sources.
	zip -q $(BUILD_DIR)/$(UUID).shell-extension.zip schemas/gschemas.compiled
	python3 tools/check-schemas.py $(BUILD_DIR)/$(UUID).shell-extension.zip
	python3 tools/test-schema-packaging.py $(BUILD_DIR)/$(UUID).shell-extension.zip

install: pack
	XDG_DATA_HOME="$(DATA_DIR)" gnome-extensions install --force $(BUILD_DIR)/$(UUID).shell-extension.zip
	glib-compile-schemas --strict "$(EXTENSION_DIR)/schemas"
	python3 tools/check-schemas.py "$(EXTENSION_DIR)"
	$(MAKE) install-service

install-service:
	install -d "$(DATA_DIR)/dbus-1/services"
	service_path="$(EXTENSION_DIR)/service/gdi-service.py"; \
	install -Dm644 service/org.gnome.DesktopIntelligence1.service.in \
		"$(DATA_DIR)/dbus-1/services/org.gnome.DesktopIntelligence1.service.in"; \
	sed "s|@SERVICE_PATH@|$$service_path|g" \
		"$(DATA_DIR)/dbus-1/services/org.gnome.DesktopIntelligence1.service.in" \
		> "$(DATA_DIR)/dbus-1/services/org.gnome.DesktopIntelligence1.service"; \
	rm "$(DATA_DIR)/dbus-1/services/org.gnome.DesktopIntelligence1.service.in"

uninstall:
	XDG_DATA_HOME="$(DATA_DIR)" gnome-extensions uninstall $(UUID)
	rm -f "$(DATA_DIR)/dbus-1/services/org.gnome.DesktopIntelligence1.service"

clean:
	rm -rf $(BUILD_DIR) schemas/gschemas.compiled

test-passive: lint
	python3 tools/test-passive-unit.py
	python3 tools/test-passive-lifecycle.py

.PHONY: test-refinement
test-refinement: test-passive
	node tools/test-actions.mjs
	node tools/test-clipboard.mjs
	node tools/test-presentation.mjs
	node tools/test-writing-menu.mjs
	python3 tools/test-writing-refinement.py
	python3 tools/test-prediction.py
	python3 tools/test-history.py
	python3 tools/test-streaming.py
	python3 tools/test-model-routing.py
	python3 tools/test-residency.py
	python3 tools/test-action-service.py
	python3 tools/test-safety.py
	python3 tools/test-provider.py
