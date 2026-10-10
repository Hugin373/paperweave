#!/usr/bin/env bash
# Starts Paperweave automatically (Linux / WSL with systemd), for a library kept on this computer.
#
#   bash scripts/autostart.sh install    — a user service that waits for the database and runs `npm start`;
#                                          on WSL also a Windows startup file that keeps WSL running
#   bash scripts/autostart.sh uninstall  — removes both
#
# Afterwards: `systemctl --user restart paperweave` (after `npm run build`), `journalctl --user -u paperweave -f`
# (logs). The service only runs without an open terminal once lingering is on: `sudo loginctl enable-linger $USER`.
set -euo pipefail
cd "$(dirname "$0")/.."

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/paperweave.service"
NPM=$(command -v npm)
# The service gets this PATH, so the claude / codex commands (subscription AI) and Node are found.
SERVICE_PATH="$(dirname "$NPM"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

startup_file() {
  local appdata
  appdata=$(cmd.exe /c "echo %APPDATA%" 2>/dev/null | tr -d '\r') || return 1
  [ -n "$appdata" ] || return 1
  echo "$(wslpath "$appdata")/Microsoft/Windows/Start Menu/Programs/Startup/paperweave-wsl.vbs"
}

case "${1:-}" in
install)
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT" <<EOF
[Unit]
Description=Paperweave
After=network-online.target

[Service]
WorkingDirectory=$PWD
Environment=PATH=$SERVICE_PATH
# Wait for the database container (it starts with Docker).
ExecStartPre=/bin/sh -c 'for i in \$(seq 90); do docker compose exec -T postgres pg_isready -U paperweave -q && exit 0; sleep 2; done; exit 1'
ExecStart=$NPM start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable paperweave.service
  echo "Installed $UNIT (enabled)."
  if [ -n "${WSL_DISTRO_NAME:-}" ] && file=$(startup_file); then
    # Starts WSL hidden at Windows sign-in and keeps it running (WSL stops when nothing runs in it).
    printf 'CreateObject("WScript.Shell").Run "wsl.exe -d %s --exec sleep infinity", 0, False\r\n' \
      "$WSL_DISTRO_NAME" >"$file"
    echo "Installed the Windows startup file: $file"
  fi
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "Next: sudo loginctl enable-linger $USER   (lets the service run without an open terminal)"
  fi
  echo "Start it now with: systemctl --user start paperweave   (stop any npm start you run yourself first)"
  ;;
uninstall)
  systemctl --user disable --now paperweave.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  if [ -n "${WSL_DISTRO_NAME:-}" ] && file=$(startup_file); then rm -f "$file"; fi
  echo "Removed. Lingering stays on; turn it off with: sudo loginctl disable-linger $USER"
  ;;
*)
  echo "Usage: bash scripts/autostart.sh install|uninstall" >&2
  exit 1
  ;;
esac
