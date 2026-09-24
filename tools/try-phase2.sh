#!/usr/bin/env bash
# Interactive, isolated GNOME 46 session for physical Phase 2 testing.
set -euo pipefail
check_mode=0
visual_mode=0
if [ "${1:-}" = --check ]; then check_mode=1
elif [ "${1:-}" = --visual ]; then check_mode=1; visual_mode=1
elif [ "$#" -ne 0 ]; then echo 'Usage: try-phase2.sh [--check|--visual]' >&2; exit 2
fi
project_root=$(cd "$(dirname "$0")/.." && pwd)
uuid=gdi@gnome.desktop.intelligence
archive="$project_root/build/$uuid.shell-extension.zip"
test -f "$archive" || { echo 'Run make lint pack first.' >&2; exit 1; }
session_root=$(mktemp -d /tmp/gdi-physical.XXXXXX)
cleanup_root() {
  if [ -n "${mock_pid:-}" ]; then kill "$mock_pid" 2>/dev/null || true; fi
  # Preferences can activate private portal/GVFS FUSE mounts. Detach only the
  # two mounts below this disposable runtime before removing its directory.
  for path in "$session_root/runtime/doc" "$session_root/runtime/gvfs"; do
    if mountpoint -q "$path"; then fusermount3 -uz "$path" 2>/dev/null || true; fi
  done
  # Activated clients can finish writing caches just after their bus exits.
  # Allow that bounded shutdown race, retaining an error if cleanup still fails.
  for _ in 1 2 3; do
    if rm -rf --one-file-system "$session_root" 2>/dev/null; then return; fi
    sleep .3
  done
  rm -rf --one-file-system "$session_root"
}
trap cleanup_root EXIT
case "${WAYLAND_DISPLAY:-wayland-0}" in
  /*) parent_display="$WAYLAND_DISPLAY" ;;
  *) parent_display="$XDG_RUNTIME_DIR/${WAYLAND_DISPLAY:-wayland-0}" ;;
esac
extension_dir="$session_root/home/.local/share/gnome-shell/extensions/$uuid"
mkdir -p "$extension_dir" "$session_root/home/.local/share/dbus-1/services" "$session_root/home/.config/dconf"
mkdir -m 700 "$session_root/runtime"
python3 "$project_root/tools/check-schemas.py" "$archive"
unzip -q "$archive" -d "$extension_dir"
glib-compile-schemas --strict "$extension_dir/schemas"
python3 "$project_root/tools/check-schemas.py" "$extension_dir"
if [ "$check_mode" -eq 1 ]; then
  probe_dir="$session_root/home/.local/share/gnome-shell/extensions/gdi-settings-test@local"
  mkdir -p "$probe_dir"
  cp "$project_root/tools/settings-probe.js" "$probe_dir/extension.js"
  cp "$project_root/tools/visual-probe.js" "$probe_dir/visual-probe.js"
  printf '%s\n' '{"uuid":"gdi-settings-test@local","name":"GDI settings test","description":"Isolated validation observer","shell-version":["46"]}' > "$probe_dir/metadata.json"
fi
if [ "$visual_mode" = 1 ]; then
  python3 "$project_root/tools/mock-provider.py" "$session_root/mock-port" &
  mock_pid=$!
  for _ in $(seq 1 30); do test -f "$session_root/mock-port" && break; sleep .1; done
  export GDI_MOCK_PORT=$(cat "$session_root/mock-port")
fi
printf 'user-db:user\n' > "$session_root/dconf-profile"
cat > "$session_root/home/.local/share/dbus-1/services/org.gnome.DesktopIntelligence1.service" <<EOF
[D-BUS Service]
Name=org.gnome.DesktopIntelligence1
Exec=/usr/bin/python3 "$extension_dir/service/gdi-service.py"
EOF
printf 'This are a synthetic writing sample. Please review the report before Friday.\n' > "$session_root/home/GDI-writing-sample.txt"
printf 'GDI physical test: use Ctrl+Super+Space inside the nested desktop.\nSelect text in the sample editor to try writing tools. Close the nested desktop to finish.\n'
env GDI_VISUAL_CHECK="$visual_mode" GDI_PHYSICAL_CHECK="$check_mode" GDI_CHECK_ROOT="$project_root" GDI_CHECK_EXTENSION="$extension_dir" HOME="$session_root/home" XDG_DATA_HOME="$session_root/home/.local/share" \
  XDG_CONFIG_HOME="$session_root/home/.config" XDG_CACHE_HOME="$session_root/home/.cache" \
  XDG_RUNTIME_DIR="$session_root/runtime" DCONF_PROFILE="$session_root/dconf-profile" \
  WAYLAND_DISPLAY="$parent_display" dbus-run-session -- bash -euo pipefail -c '
    gsettings set org.gnome.shell enabled-extensions "[\"gdi@gnome.desktop.intelligence\"]"
    if [ "$GDI_PHYSICAL_CHECK" = 1 ]; then
      gsettings set org.gnome.shell enabled-extensions "[\"gdi@gnome.desktop.intelligence\",\"gdi-settings-test@local\"]"
    fi
    if [ "$GDI_VISUAL_CHECK" = 1 ]; then
      export MUTTER_DEBUG_DUMMY_MODE_SPECS=1280x900
    fi
    nested_display="gdi-physical-$$"
    gnome-shell --mode=gnome --nested --wayland --no-x11 --wayland-display="$nested_display" &
    shell_pid=$!
    editor_pid=""
    cleanup() {
      if [ -n "$editor_pid" ]; then kill "$editor_pid" 2>/dev/null || true; fi
      kill "$shell_pid" 2>/dev/null || true
      wait "$shell_pid" 2>/dev/null || true
    }
    trap cleanup EXIT
    for _ in $(seq 1 80); do
      test -S "$XDG_RUNTIME_DIR/$nested_display" && break
      kill -0 "$shell_pid" 2>/dev/null || exit 1
      sleep .1
    done
    export WAYLAND_DISPLAY="$nested_display" GDK_BACKEND=wayland GTK_A11Y=atspi
    # Update this private D-Bus only; do not change the host systemd environment.
    dbus-update-activation-environment WAYLAND_DISPLAY GDK_BACKEND GTK_A11Y
    sleep 2
    if [ "$GDI_PHYSICAL_CHECK" = 1 ]; then
      if [ "$GDI_VISUAL_CHECK" = 1 ]; then
        python3 "$GDI_CHECK_ROOT/tools/test-visuals.py" "$GDI_CHECK_EXTENSION"
      else
        python3 "$GDI_CHECK_ROOT/tools/test-installed-settings.py" "$GDI_CHECK_EXTENSION"
      fi
      exit
    fi
    WAYLAND_DISPLAY="$nested_display" GTK_A11Y=atspi GDK_BACKEND=wayland \
      gnome-text-editor --standalone "$HOME/GDI-writing-sample.txt" &
    editor_pid=$!
    wait "$shell_pid"
  '
