#!/bin/bash
# Team Leader — macOS launcher
# Double-click this file (or run it from terminal) to start the logger.
# It will open a Terminal window, start the server, and open the browser.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTTP_PORT=7375

# ── Check Node.js is available ──────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  osascript -e 'display alert "Node.js not found" message "Please install Node.js from https://nodejs.org or run: brew install node" as critical'
  exit 1
fi

# ── Check dependencies are installed ────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  osascript -e 'display alert "Dependencies missing" message "Running npm install — this will take about 30 seconds the first time." as informational'
  cd "$SCRIPT_DIR" && npm install
  if [ $? -ne 0 ]; then
    osascript -e 'display alert "npm install failed" message "Check your internet connection and try running npm install manually in the project folder." as critical'
    exit 1
  fi
fi

# ── Kill any previous instance on our port ──────────────────────────────────
lsof -ti tcp:$HTTP_PORT | xargs kill -9 2>/dev/null
lsof -ti tcp:7373 | xargs kill -9 2>/dev/null

# ── Launch server in a new Terminal window ───────────────────────────────────
osascript <<APPLESCRIPT
tell application "Terminal"
    activate
    set w to do script "cd '$SCRIPT_DIR' && node server.js"
    set custom title of w to "Team Leader Logger"
end tell
APPLESCRIPT

# ── Wait for server to be ready ──────────────────────────────────────────────
echo "Waiting for server to start..."
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$HTTP_PORT/api/config" &>/dev/null; then
    break
  fi
  sleep 0.5
done

# ── Open browser ─────────────────────────────────────────────────────────────
open "http://localhost:$HTTP_PORT"

echo "Team Leader is running at http://localhost:$HTTP_PORT"
