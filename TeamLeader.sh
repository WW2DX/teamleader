#!/usr/bin/env bash
# Team Leader — Linux Launcher
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/electron" ]; then
  echo "Setting up Team Leader (first run)..."
  npm install --quiet 2>&1 | grep -E "error|warn|added" || true
  echo "✓ Setup complete"
fi

if [ -f "node_modules/.bin/electron" ]; then
  exec npx electron . 2>/tmp/teamleader.log
else
  node server.js &
  SERVER_PID=$!
  sleep 2
  xdg-open http://localhost:7375 2>/dev/null || \
    firefox http://localhost:7375 2>/dev/null || \
    google-chrome http://localhost:7375 2>/dev/null || \
    chromium-browser http://localhost:7375 2>/dev/null
  echo "Team Leader running at http://localhost:7375"
  wait $SERVER_PID
fi
