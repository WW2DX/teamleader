#!/bin/bash
# Team Leader — macOS launcher
# Double-click this file to start Team Leader.
# Launches the Electron native app if available, falls back to browser.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
HTTP_PORT=7375

# ── Check Node.js is available ──────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  osascript -e 'display alert "Node.js not found" message "Please install Node.js from https://nodejs.org or run: brew install node" as critical'
  exit 1
fi

# ── Check dependencies are installed ────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "First run — installing dependencies..."
  npm install --quiet 2>&1 | grep -E "error|warn|added" || true
  echo "✓ Setup complete"
fi

# ── Launch Electron if available ────────────────────────────────────────────
if [ -f "node_modules/.bin/electron" ] || [ -d "node_modules/electron" ]; then
  exec npx electron . 2>/tmp/teamleader-electron.log
fi

# ── Fallback: web server + browser ──────────────────────────────────────────
echo "Electron not found — launching in browser mode..."
echo "To install the native app: bash install-electron.sh"

# Kill any previous instance
lsof -ti tcp:$HTTP_PORT | xargs kill -9 2>/dev/null

node server.js &
SERVER_PID=$!

# Wait for server
for i in $(seq 1 20); do
  sleep 0.3
  curl -s http://localhost:$HTTP_PORT >/dev/null 2>&1 && break
done

open "http://localhost:$HTTP_PORT" 2>/dev/null

echo "Team Leader running at http://localhost:$HTTP_PORT"
echo "Close this terminal to stop the server."
wait $SERVER_PID
