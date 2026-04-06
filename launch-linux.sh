#!/bin/bash
# Team Leader — Linux launcher
# Run this to start the logger on Linux (desktop or server).
# On the DXpedition kit this is called automatically on boot via systemd.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTTP_PORT=7375

# ── Check Node.js ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found."
  echo "Install with: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VER=$(node --version | cut -c2- | cut -d. -f1)
if [ "$NODE_VER" -lt 16 ]; then
  echo "WARNING: Node.js $NODE_VER detected. Version 16+ recommended."
fi

# ── Install deps if needed ────────────────────────────────────────────────────
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  cd "$SCRIPT_DIR" && npm install
fi

# ── Kill any previous instance ────────────────────────────────────────────────
fuser -k ${HTTP_PORT}/tcp 2>/dev/null
fuser -k 7373/tcp 2>/dev/null
fuser -k 7374/tcp 2>/dev/null

cd "$SCRIPT_DIR"

# ── Kiosk mode: launch Chromium pointing at local server ─────────────────────
if [ "${1}" = "--kiosk" ]; then
  echo "Starting in kiosk mode..."
  node server.js &
  SERVER_PID=$!

  # Wait for server
  for i in $(seq 1 20); do
    curl -sf "http://localhost:$HTTP_PORT/api/config" &>/dev/null && break
    sleep 0.5
  done

  # Launch Chromium kiosk (adjust binary name for your distro)
  CHROMIUM=$(command -v chromium-browser || command -v chromium || command -v google-chrome)
  if [ -n "$CHROMIUM" ]; then
    "$CHROMIUM" \
      --kiosk \
      --no-sandbox \
      --disable-infobars \
      --disable-session-crashed-bubble \
      --disable-features=TranslateUI \
      --app="http://localhost:$HTTP_PORT"
  fi

  wait $SERVER_PID

# ── Normal mode: just run the server ─────────────────────────────────────────
else
  echo ""
  echo "  Starting Team Leader..."
  echo "  Open http://localhost:$HTTP_PORT in your browser"
  echo "  Press Ctrl+C to stop"
  echo ""
  node server.js
fi
