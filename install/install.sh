#!/usr/bin/env bash
# Token View installer (Linux, systemd user services).
#
#   ./install/install.sh            # install service + launcher + desktop entry
#   ./install/install.sh --no-start # install without starting the service
#   ./install/install.sh --uninstall # remove everything this script installed
#
# Expects the repository to live at ~/Token-View (clone it there), and
# node 18+ to be on PATH.
set -euo pipefail

APP_DIR="$HOME/Token-View"
SERVICE="$HOME/.config/systemd/user/token-view.service"
DESKTOP="$HOME/.local/share/applications/token-view.desktop"
BIN_DIR="$HOME/.local/bin"

usage() {
  echo "usage: install.sh [--no-start] [--uninstall]"
  exit 1
}

NO_START=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) usage ;;
  esac
done

if [ "$UNINSTALL" = 1 ]; then
  systemctl --user disable --now token-view.service 2>/dev/null || true
  rm -f "$SERVICE" "$DESKTOP" "$BIN_DIR/token-view" "$BIN_DIR/token-view-server"
  systemctl --user daemon-reload 2>/dev/null || true
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "token-view uninstalled."
  exit 0
fi

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "error: expected the repo at $APP_DIR (server.js not found)." >&2
  echo "clone it first:  git clone <repo-url> ~/Token-View" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH (need Node 18+)." >&2
  exit 1
fi

mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/applications" "$BIN_DIR"

cp "$APP_DIR/install/token-view.service" "$SERVICE"
cp "$APP_DIR/install/token-view.desktop" "$DESKTOP"
cp "$APP_DIR/install/token-view" "$BIN_DIR/token-view"
cp "$APP_DIR/install/token-view-server" "$BIN_DIR/token-view-server"
chmod +x "$BIN_DIR/token-view" "$BIN_DIR/token-view-server" "$APP_DIR/install/install.sh"

systemctl --user daemon-reload
systemctl --user enable token-view.service
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

if [ "$NO_START" = 0 ]; then
  systemctl --user restart token-view.service
  sleep 3
  if systemctl --user is-active --quiet token-view.service; then
    echo "token-view is running at http://localhost:4173"
  else
    echo "service failed to start — check: journalctl --user -u token-view -n 30" >&2
    exit 1
  fi
else
  echo "installed (not started). start with: systemctl --user start token-view"
fi

echo "open it from your app menu (\"Token View\") or run: token-view"
