#!/usr/bin/env bash
# Team Leader — Launch Native App (macOS)
# Double-click this file to start Team Leader as a native app.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if electron is installed
if [ ! -d "node_modules/electron" ]; then
  osascript -e 'display alert "Setup required" message "Run install-electron.sh first to set up the native app.\n\nOpen Terminal and run:\n  bash install-electron.sh" as informational'
  exit 1
fi

# Launch
exec npx electron .
