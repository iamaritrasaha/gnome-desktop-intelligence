#!/usr/bin/env bash
# Optional, explicit, reversible Ollama server tuning for desktop use.
#
# GDI never edits Ollama configuration on its own: the Ollama daemon is shared
# with other applications. This helper exists for users who want to try the
# documented desktop profile on a limited-VRAM machine. It shows exactly what
# it will change, writes a systemd drop-in (never touching the original unit),
# keeps a timestamped backup of the previous override state, and reverts.
#
# Usage:
#   tools/ollama-desktop-profile.sh show      # current unit + effective env
#   sudo tools/ollama-desktop-profile.sh apply  # write the drop-in, restart ollama
#   sudo tools/ollama-desktop-profile.sh revert # remove the drop-in, restart ollama
#
# The profile (see docs/ARCHITECTURE.md, "Ollama server profile"):
#   OLLAMA_MAX_LOADED_MODELS=1   one model resident at a time — matches GDI's
#                                one-generation scheduling on limited VRAM
#   OLLAMA_NUM_PARALLEL=1        no parallel request slots (they multiply KV
#                                cache VRAM even when idle)
#   OLLAMA_FLASH_ATTENTION=1     lower KV memory use, faster attention where
#                                supported
#   OLLAMA_KV_CACHE_TYPE=q8_0    8-bit KV cache — roughly halves cache VRAM
#                                with negligible quality impact on small models
#
# Applying restarts the system ollama service, which unloads every resident
# model (including ones other applications loaded). Review `show` first.
set -euo pipefail

OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="$OVERRIDE_DIR/gdi-desktop-profile.conf"
BACKUP_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/gdi/ollama-profile-backups"

profile_conf() {
  cat <<'EOF'
# GDI desktop profile (tools/ollama-desktop-profile.sh)
[Service]
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
EOF
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "apply/revert change the system ollama unit: run them with sudo." >&2
    exit 1
  fi
}

case "${1:-}" in
  show)
    echo "== unit =="
    systemctl cat ollama || true
    echo
    echo "== effective OLLAMA_* environment =="
    systemctl show ollama -p Environment | tr ' ' '\n' | grep '^OLLAMA_' || echo "(none set)"
    echo
    echo "== override drop-in present? =="
    if [ -f "$OVERRIDE_FILE" ]; then
      echo "yes: $OVERRIDE_FILE"
      cat "$OVERRIDE_FILE"
    else
      echo "no"
    fi
    ;;
  apply)
    require_root
    echo "Intended change — create $OVERRIDE_FILE with:"
    profile_conf
    echo
    echo "Then: systemctl daemon-reload && systemctl restart ollama"
    printf 'Continue? [y/N] '
    read -r answer
    [ "$answer" = "y" ] || { echo "aborted"; exit 1; }
    if [ -f "$OVERRIDE_FILE" ]; then
      mkdir -p "$BACKUP_DIR"
      backup="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-gdi-desktop-profile.conf"
      cp "$OVERRIDE_FILE" "$backup"
      echo "existing override backed up to $backup"
    fi
    mkdir -p "$OVERRIDE_DIR"
    profile_conf > "$OVERRIDE_FILE"
    systemctl daemon-reload
    systemctl restart ollama
    echo "applied. Verify with: tools/ollama-desktop-profile.sh show"
    echo "Revert any time with: sudo tools/ollama-desktop-profile.sh revert"
    ;;
  revert)
    require_root
    if [ -f "$OVERRIDE_FILE" ]; then
      mkdir -p "$BACKUP_DIR"
      backup="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-removed-gdi-desktop-profile.conf"
      cp "$OVERRIDE_FILE" "$backup"
      rm "$OVERRIDE_FILE"
      rmdir "$OVERRIDE_DIR" 2>/dev/null || true
      systemctl daemon-reload
      systemctl restart ollama
      echo "reverted (backup: $backup)"
    else
      echo "nothing to revert: $OVERRIDE_FILE does not exist"
    fi
    ;;
  *)
    echo "usage: $0 {show|apply|revert}" >&2
    exit 2
    ;;
esac
