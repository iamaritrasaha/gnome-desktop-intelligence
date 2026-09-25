#!/usr/bin/env bash
set -euo pipefail

uuid='gdi@gnome.desktop.intelligence'
test_root=$(mktemp -d /tmp/gdi-shell-check.XXXXXX)
cleanup() {
  if [ -n "${mock_pid:-}" ]; then kill "$mock_pid" 2>/dev/null || true; fi
  rm -rf "$test_root"
}
trap cleanup EXIT

test_home="$test_root/home"
extension_dir="$test_home/.local/share/gnome-shell/extensions/$uuid"
applications="$test_home/.local/share/applications"
mkdir -p "$extension_dir" "$test_home/.config/dconf" "$applications" \
  "$test_home/gdi-smoke-files" "$test_home/.local/share/dbus-1/services"
python3 "$(dirname "$0")/check-schemas.py" "$(dirname "$0")/../build/$uuid.shell-extension.zip"
unzip -q "$(dirname "$0")/../build/$uuid.shell-extension.zip" -d "$extension_dir"
python3 "$(dirname "$0")/check-schemas.py" "$extension_dir"
glib-compile-schemas --strict "$extension_dir/schemas"
cp "$(dirname "$0")/geometry-regression.js" "$extension_dir/geometry-regression.js"
cp "$(dirname "$0")/intelligence-regression.js" "$extension_dir/intelligence-regression.js"
python3 "$(dirname "$0")/mock-provider.py" "$test_root/mock-port" &
mock_pid=$!
for _ in $(seq 1 30); do test -f "$test_root/mock-port" && break; sleep .1; done
export GDI_MOCK_PORT=$(cat "$test_root/mock-port")
cat > "$test_home/.local/share/dbus-1/services/org.gnome.DesktopIntelligence1.service" <<EOF
[D-BUS Service]
Name=org.gnome.DesktopIntelligence1
Exec=/usr/bin/python3 "$extension_dir/service/gdi-service.py"
EOF
touch "$test_home/gdi-smoke-files/gdi-migration-fixture.txt"
cat > "$applications/gdi-alpha.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GDI Alpha
Exec=/usr/bin/touch $test_home/gdi-app-launch-confirmed
Icon=application-x-executable
Terminal=false
Categories=Utility;
EOF
cat > "$applications/gdi-alpine.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GDI Alpine
Exec=/usr/bin/true
Icon=application-x-executable
Terminal=false
Categories=Utility;
EOF
for number in $(seq 1 8); do
  cat > "$applications/gdi-utility-$number.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GDI Utility $number
Exec=/usr/bin/true
Icon=application-x-executable
Terminal=false
Categories=Utility;
EOF
done

python3 - "$extension_dir/extension.js" "$test_home/gdi-app-launch-confirmed" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
marker = "    this._updateShortcut();\n  }\n\n  disable()"
source = path.read_text()
source = source.replace("import Gio from 'gi://Gio';", "import Gio from 'gi://Gio';\nimport GLib from 'gi://GLib';\nimport {validateGeometry} from './geometry-regression.js';\nimport {validateIntelligence, validateActions} from './intelligence-regression.js';")
probe = r'''    if (global._gdiSmokeProbeStarted)
      return;
    global._gdiSmokeProbeStarted = true;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
      Main.overview.hide();
      const palette = this._palette;
      const report = (name, value) => console.log(`GDI_TEST ${name}=${value}`);
      const after = (milliseconds, callback) => GLib.timeout_add(
        GLib.PRIORITY_DEFAULT, milliseconds, () => {
          callback();
          return GLib.SOURCE_REMOVE;
        });
      const appLaunched = PATH_TO_APP_MARKER;
      const hasType = type => palette._items.some(item => item.type === type);
      const preferredHeight = () => palette._palette.get_preferred_height(
        palette._palette.width)[1];

      (async () => {
      await validateGeometry(palette, report);
      await validateIntelligence(palette, report);
      await validateActions(palette, report);
      const normalGeometry = palette._calculatePlacement(
        { x: 0, y: 0, width: 1920, height: 1080 }, 400, 32);
      const mediumGeometry = palette._calculatePlacement(
        { x: 0, y: 0, width: 1280, height: 720 }, 400, 32);
      const compactGeometry = palette._calculatePlacement(
        { x: 0, y: 0, width: 800, height: 430 }, 400, 32);
      const narrowGeometry = palette._calculatePlacement(
        { x: 0, y: 0, width: 480, height: 270 }, 400, 32);
      const viewportModes = [
        palette._getViewportMode(1080, 32) === 'normal',
        palette._getViewportMode(430, 32) === 'compact',
        palette._getViewportMode(330, 32) === 'short',
        palette._getViewportMode(270, 32) === 'tiny',
      ];
      const geometries = [
        [normalGeometry, 1920, 1080],
        [mediumGeometry, 1280, 720],
        [compactGeometry, 800, 430],
        [narrowGeometry, 480, 270],
      ];
      report('resolution-scaling-geometry', geometries.every(([layout, width, height]) =>
        layout.width <= width - 32 && layout.x >= 0 && layout.y >= 0 &&
        layout.x + layout.width <= width && layout.y + layout.height <= height));
      report('responsive-viewport-modes', viewportModes.every(Boolean));

      palette.open();
      const emptyHeight = preferredHeight();
      report('palette-open', palette._isOpen && palette._overlay.visible);
      report('empty-state', palette._items.length === 0 &&
        palette._palette.get_n_children() === 4);
      after(250, () => {
        const monitor = Main.layoutManager.primaryMonitor;
        const [x, y] = palette._palette.get_transformed_position();
        const width = palette._palette.width;
        const height = palette._palette.height;
        report('entry-focus', palette._entry.contains(global.stage.get_key_focus()));
        report('palette-width', width >= Math.min(499, monitor.width - 32) &&
          width <= Math.min(501, monitor.width - 32));
        report('palette-layout-bounds', x >= monitor.x &&
          x + width <= monitor.x + monitor.width &&
          y >= monitor.y + Main.panel.height &&
          y + height <= monitor.y + monitor.height);
        report('upper-middle-position', y < monitor.y + monitor.height * 0.55);

        palette._entry.set_text('GDI Alpha');
        after(190, () => {
          report('app-search', palette._items.some(item =>
            item.type === 'app' && item.name === 'GDI Alpha'));
          report('dynamic-height-growth', preferredHeight() > emptyHeight);
          const appIndex = palette._items.findIndex(item =>
            item.type === 'app' && item.name === 'GDI Alpha');
          if (appIndex >= 0)
            palette._activateItem(appIndex);
          after(220, () => {
            report('app-launch', GLib.file_test(appLaunched, GLib.FileTest.EXISTS));
            palette.open();
            palette._entry.set_text('file gdi-migration-fixture');
            let fileAttempts = 0;
            const waitForFile = () => {
              if (hasType('file') || fileAttempts++ >= 25) {
                report('file-search', hasType('file') && palette._items.some(item =>
                  item.type === 'file' && item.name === 'gdi-migration-fixture.txt'));
                palette._entry.set_text('12 * (3 + 1)');
                after(150, () => {
                  report('calculator', hasType('calc') && palette._items[0].value === '48');
                  palette._entry.set_text('search transformers attention');
                  after(150, () => {
                    report('web-search', hasType('web') &&
                      palette._items[0].query === 'transformers attention');
                    palette._entry.set_text('GDI');
                    after(180, () => {
                      const hadChoices = palette._items.length > 1;
                      palette._moveSelection(1);
                      const selectionMoved = hadChoices && palette._selectedIndex === 1 &&
                        palette._results.get_children()[1].has_style_pseudo_class('focus');
                      const selectedName = palette._items[palette._selectedIndex]?.name;
                      const completed = palette._completeSelectedApp() &&
                        palette._entry.get_text() === selectedName;
                      report('navigation-and-completion-logic',
                        selectionMoved && completed);
                      report('result-limit', palette._items.length === 4);
                      const resultMonitor = Main.layoutManager.primaryMonitor;
                      const [resultX, resultY] = palette._palette.get_transformed_position();
                      const resultWidth = palette._palette.width;
                      const resultHeight = palette._palette.height;
                      report('results-layout-bounds', resultX >= resultMonitor.x &&
                        resultX + resultWidth <= resultMonitor.x + resultMonitor.width &&
                        resultY >= resultMonitor.y + Main.panel.height &&
                        resultY + resultHeight <=
                          resultMonitor.y + resultMonitor.height);
                      palette._writingContext = { selected: 'fixture selection',
                        capabilities: { canReadSelection: true } };
                      palette._showWritingActions();
                      report('writing-tools-primary-chips', palette._mode === 'writing-actions' &&
                        palette._writingControls.get_children().length === 5 &&
                        palette._scrollView.visible === false);
                      const expandedHeight = preferredHeight();
                      const menuItems = this._indicator.menu._getMenuItems();
                      report('panel-indicator-menu',
                        Main.panel.statusArea['gdi-indicator'] === this._indicator &&
                        menuItems.length === 5 && menuItems[2].label.text === 'Settings' &&
                        menuItems[3].label.text === 'Intelligence History' &&
                        menuItems[4].label.text === 'Quit Intelligence');

                      palette.close();
                      after(180, () => {
                        report('close-transition', !palette._isOpen &&
                          !palette._overlay.visible);
                        report('dynamic-height-shrink',
                          preferredHeight() < expandedHeight &&
                          palette._items.length === 0);
                        const motionSettings = new Gio.Settings({
                          schema_id: 'org.gnome.desktop.interface',
                        });
                        const originalAnimations = motionSettings.get_boolean(
                          'enable-animations');
                        motionSettings.set_boolean('enable-animations', false);
                        const validateMotion = () => {
                          const disabled = !palette._animationsEnabled;
                          palette.open();
                          const instantOpen = palette._palette.opacity === 255;
                          palette.close();
                          const instantClose = !palette._overlay.visible;
                          report('reduced-motion', disabled &&
                            instantOpen && instantClose);
                          motionSettings.set_boolean('enable-animations',
                            originalAnimations);
                          Main.overview.hide();
                          report('probe-complete', true);
                        };

                        this._onShortcutPressed();
                        let shortcutAttempts = 0;
                        const waitForShortcut = () => {
                          if (!palette._isOpen && shortcutAttempts++ < 80) {
                            after(100, waitForShortcut);
                            return;
                          }
                          const toggledOpen = palette._isOpen;
                          if (toggledOpen)
                            this._onShortcutPressed();
                          after(180, () => {
                            report('shortcut-toggle-path', this._shortcutBound &&
                              toggledOpen && !palette._isOpen);
                            after(100, validateMotion);
                          });
                        };
                        after(100, waitForShortcut);
                      });
                    });
                  });
                });
                return;
              }
              after(100, waitForFile);
            };
            after(140, waitForFile);
          });
        });
      });
      })().catch(error => { report('geometry-probe-error', error.stack); });
      return GLib.SOURCE_REMOVE;
    });
'''.replace('PATH_TO_APP_MARKER', repr(sys.argv[2]))
if marker not in source:
    raise SystemExit("Unable to insert the temporary migration smoke probe")
path.write_text(source.replace(marker, marker.replace("  }\n\n  disable()", "" ) + probe + "  }\n\n  disable()", 1))
PY

printf 'user-db:user\n' > "$test_root/dconf-profile"
# Give nested accessibility its own socket directory; never share the active
# session's at-spi socket. The parent compositor is addressed absolutely.
case "${WAYLAND_DISPLAY:-wayland-0}" in
  /*) ;;
  *) export WAYLAND_DISPLAY="$XDG_RUNTIME_DIR/${WAYLAND_DISPLAY:-wayland-0}" ;;
esac
export XDG_RUNTIME_DIR="$test_root/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"
export HOME="$test_home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export DCONF_PROFILE="$test_root/dconf-profile"
export GDI_TEST_ROOT="$(pwd)"

if dbus-run-session -- bash -euo pipefail -c '
  uuid="gdi@gnome.desktop.intelligence"
  gsettings set org.gnome.shell enabled-extensions "[\"$uuid\"]"

  nested_display="gdi-test-$$"
  export GDI_NESTED_DISPLAY="$nested_display" GDK_BACKEND=wayland GTK_A11Y=atspi
  gnome-shell --mode=gnome --nested --wayland --no-x11 --wayland-display="$nested_display" > "$HOME/nested-shell.log" 2>&1 &
  shell_pid=$!
  stop_shell() {
    kill -TERM "$shell_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$shell_pid" 2>/dev/null || true
    wait "$shell_pid" 2>/dev/null || true
  }
  trap stop_shell EXIT

  ready=false
  for _attempt in $(seq 1 40); do
    if gdbus call --session --dest org.gnome.Shell.Extensions \
      --object-path /org/gnome/Shell/Extensions \
      --method org.gnome.Shell.Extensions.GetExtensionInfo "$uuid" \
      > /dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 1
  done
  if [ "$ready" != true ]; then
    cat "$HOME/nested-shell.log"
    echo "Nested GNOME Shell did not become ready" >&2
    exit 1
  fi

  echo "Extension state:"
  gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$uuid"
  echo "Extension errors:"
  errors=$(gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionErrors "$uuid")
  echo "$errors"
  if [[ "$errors" != *"@as []"* ]]; then
    echo "GDI reported Shell load errors" >&2
    exit 1
  fi

  for _attempt in $(seq 1 140); do
    if rg -q "GDI_TEST probe-complete=true" "$HOME/nested-shell.log"; then
      break
    fi
    sleep 0.25
  done
  if ! rg -q "GDI_TEST probe-complete=true" "$HOME/nested-shell.log"; then
    echo "Nested palette probe did not finish" >&2
    exit 1
  fi
  gnome-extensions disable "$uuid"
  sleep 1
  gnome-extensions enable "$uuid"
  sleep 1
  reload_info=$(gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$uuid")
  if [[ "$reload_info" != *enabled*"<true>"* ]]; then
    echo "GDI did not re-enable cleanly: $reload_info" >&2
    exit 1
  fi
  reload_errors=$(gdbus call --session --dest org.gnome.Shell.Extensions \
    --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionErrors "$uuid")
  if [[ "$reload_errors" != *"@as []"* ]]; then
    echo "GDI reported errors after re-enable: $reload_errors" >&2
    exit 1
  fi
  echo "Extension reload: clean"
  gnome-extensions disable "$uuid"
  echo "Extension disable/re-enable lifecycle: clean"
  export WAYLAND_DISPLAY="$nested_display"
  test -n "$WAYLAND_DISPLAY"
  python3 "$GDI_TEST_ROOT/tools/test-writing-service.py" "$HOME" > "$HOME/writing-service-test.log" 2>&1
  python3 "$GDI_TEST_ROOT/tools/test-real-editors.py" "$HOME" > "$HOME/real-editors.log" 2>&1

  echo "Nested Shell log (GDI messages):"
  rg -i "gdi|extension.*(error|failed)" "$HOME/nested-shell.log" || true
' > "$test_root/session.log" 2>&1; then
  status=0
else
  status=$?
fi

cp "$HOME/writing-service-test.log" "$test_root/writing-service-test.log" 2>/dev/null || true
mkdir -p "$GDI_TEST_ROOT/build/validation"
cp "$HOME/nested-shell.log" "$GDI_TEST_ROOT/build/validation/shell.log"
cp "$test_root/session.log" "$GDI_TEST_ROOT/build/validation/session.log"
cp "$HOME/real-editors.log" "$GDI_TEST_ROOT/build/validation/real-editors.log" 2>/dev/null || true
cp "$test_root/writing-service-test.log" "$GDI_TEST_ROOT/build/validation/atspi.log" 2>/dev/null || true

rg -e '^Extension state:' -e '^Extension errors:' -e '^Extension reload:' \
  -e '^Extension disable/re-enable lifecycle:' \
  -e '^Nested Shell log' "$test_root/session.log" || true
rg 'GDI_TEST' "$test_root/session.log" "$HOME/nested-shell.log" 2>/dev/null || true
rg 'GDI_ATSPI' "$test_root/writing-service-test.log" 2>/dev/null || true
for expected in \
  'writing-tools-preview-transition=true' \
  'preview-tab-navigation=true' \
  'preview-backtab-navigation=true' \
  'preview-enter-replaces=true' \
  'preview-preserves-surroundings=true' \
  'preview-undo=true' \
  'preview-escape-closes=true' \
  'ask-fallback=true' \
  'ask-response=true' \
  'ask-no-replace=true' \
  'ask-processing-animation=true' \
  'ask-fixed-width-loading=true' \
  'ask-fixed-width-streaming=true' \
  'ask-fixed-width-result=true' \
  'markdown-code-copy-control=true' \
  'markdown-no-token-flash=true' \
  'ask-question-shown-subdued=true' \
  'history-conversation-created=true' \
  'history-groups-rendered=true' \
  'history-list-has-entry=true' \
  'history-conversation-restored=true' \
  'history-continue-id-resumed=true' \
  'history-continue-answers=true' \
  'history-delete-removes-row=true' \
  'history-clear-arms-confirm=true' \
  'history-clear-empties-list=true' \
  'history-disabled-no-conversation=true' \
  'writing-tools-primary=true' \
  'writing-tools-selection-preview=true' \
  'writing-tools-tone-submenu=true' \
  'writing-tools-more-submenu=true' \
  'writing-tools-escape-returns-from-question=true' \
  'writing-tools-preview-transition=true' \
  'writing-tools-preview-diff=true' \
  'contextual-writing-surface=true' \
  'ask-bare-row-prompt-only=true' \
  'ask-bare-enters-empty-prompt=true' \
  'ask-empty-enter-no-request=true' \
  'ask-prompt-sends-only-question=true' \
  'ask-prefix-stripped-for-provider=true' \
  'natural-question-verbatim=true' \
  'copy-response=true' \
  'retry-loading=true' \
  'incremental-streaming=true' \
  'markdown-heading-code-link=true' \
  'temporary-followup-context=true' \
  'followup-response=true' \
  'clear-forgets-conversation=true' \
  'obsolete-stream-cannot-overwrite=true' \
  'selection-natural-intent=true' \
  'selection-context-transparent=true' \
  'selection-intent-verb-stripped=true' \
  'selection-ask-bare-enters-question-prompt=true' \
  'capture-capabilities=true' \
  'insertion-caret-snapshot=true' \
  'insert-action-available=true' \
  'insert-exact-caret=true' \
  'insert-undo=true' \
  'stale-insertion-refused=true' \
  'long-answer-wrapped=true' \
  'long-answer-bounded=true' \
  'generating-shell-responsive=true' \
  'cancel-clears-context=true' \
  'launcher-after-cancel=true' \
  'ask-provider-error-visible=true' \
  'query-width-invariant=true' \
  'query-top-invariant=true' \
  'query-center-invariant=true' \
  'compact-dynamic-height=true' \
  'compact-row-height=true' \
  'four-result-cap=true' \
  'long-titles-ellipsized=true' \
  'palette-open=true' \
  'empty-state=true' \
  'resolution-scaling-geometry=true' \
  'responsive-viewport-modes=true' \
  'entry-focus=true' \
  'palette-width=true' \
  'palette-layout-bounds=true' \
  'upper-middle-position=true' \
  'app-search=true' \
  'dynamic-height-growth=true' \
  'app-launch=true' \
  'file-search=true' \
  'calculator=true' \
  'web-search=true' \
  'navigation-and-completion-logic=true' \
  'result-limit=true' \
  'results-layout-bounds=true' \
  'writing-tools-primary-chips=true' \
  'panel-indicator-menu=true' \
  'close-transition=true' \
  'dynamic-height-shrink=true' \
  'shortcut-toggle-path=true' \
  'reduced-motion=true' \
  'action-row-disk=true' \
  'disk-info-result=true' \
  'memory-info-result=true' \
  'color-scheme-action=true' \
  'audio-unavailable-graceful=true' \
  'wifi-off-plans-confirmation=true' \
  'confirmation-view=true' \
  'confirmation-cancel-closes=true' \
  'bluetooth-state-readable=true' \
  'power-profile-readable=true' \
  'network-status-readable=true' \
  'multi-step-row=true' \
  'multi-step-executed=true' \
  'model-suggested-action-validated=true' \
  'invalid-model-tool-call-falls-back-to-ask=true' \
  'model-state-change-plans-confirmation=true' \
  'model-state-change-confirmation-view=true' \
  'model-state-change-cancel-closes=true' \
  'noun-phrase-not-model-routed=true' \
  'multi-step-tell-me-disk=true' \
  'diagnostics-view-shown=true' \
  'diagnostics-reset-button=true' \
  'diagnostics-reset-clears=true' \
  'probe-complete=true'; do
  if ! grep -Fq "GDI_TEST $expected" "$HOME/nested-shell.log"; then
    echo "Nested UI check did not pass: $expected" >&2
    status=1
  fi
done
for expected in \
  'selected-text-read=PASS' \
  'capability-model-reported=PASS' \
  'selection-and-caret-offsets=PASS' \
  'bounded-nearby-context=PASS' \
  'ollama-unavailable-clean-failure=PASS' \
  'service-survives-provider-failure=PASS' \
  'exact-range-replacement=PASS' \
  'different-selection-refused=PASS' \
  'edit-and-revert-still-stale=PASS' \
  'stale-undo-refused=PASS' \
  'readonly-selection-captured=PASS' \
  'readonly-not-replaceable=PASS' \
  'readonly-replace-refused=PASS' \
  'released-context-unusable=PASS' \
  'precise-undo=PASS' \
  'password-field-not-captured=PASS' \
  'password-capability-reason=PASS'; do
  if ! grep -Fq "GDI_ATSPI $expected" "$test_root/writing-service-test.log"; then
    echo "Nested writing check did not pass: $expected" >&2
    status=1
  fi
done
if rg -q 'GDI_TEST .*=(false|.*Error)' "$HOME/nested-shell.log"; then
  status=1
fi
if [ "$status" -ne 0 ]; then
  rg -i "gdi|error|failed|not become ready" "$test_root/session.log" "$HOME/nested-shell.log" 2>/dev/null | tail -50 || true
  exit "$status"
fi
