#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════╗
# ║   Team Leader — Double-click to launch              ║
# ╚══════════════════════════════════════════════════════╝
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── First run: install dependencies ───────────────────────────────────────────
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.bin/electron" ]; then
  echo "Setting up Team Leader (first run)..."
  
  # Install npm dependencies including Electron
  npm install --quiet 2>&1 | grep -E "error|warn|added" || true
  
  # Generate macOS icon
  if [[ "$(uname)" == "Darwin" ]] && command -v iconutil &>/dev/null; then
    ICONSET="electron/build/icon.iconset"
    mkdir -p "$ICONSET"
    for size in 16 32 64 128 256 512; do
      src="electron/build/icon_${size}.png"
      [ -f "$src" ] && cp "$src" "$ICONSET/icon_${size}x${size}.png"
      [ -f "$src" ] && cp "$src" "$ICONSET/icon_${size}x${size}@2x.png" 2>/dev/null
    done
    iconutil -c icns "$ICONSET" -o "electron/build/icon.icns" 2>/dev/null && \
      echo "✓ App icon generated" || true
    rm -rf "$ICONSET"
  fi
  
  echo "✓ Setup complete"
fi

# ── Launch ─────────────────────────────────────────────────────────────────────
if [ -f "node_modules/.bin/electron" ] || [ -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  # Launch Electron native app (server starts inside it)
  exec npx electron . 2>/tmp/teamleader-electron.log
else
  # Fallback: web server + browser
  echo "Electron not found, launching in browser mode..."
  node server.js &
  SERVER_PID=$!
  
  # Wait for server
  for i in $(seq 1 20); do
    sleep 0.3
    curl -s http://localhost:7375 >/dev/null 2>&1 && break
  done
  
  open http://localhost:7375 2>/dev/null || xdg-open http://localhost:7375 2>/dev/null
  
  echo "Team Leader running at http://localhost:7375"
  echo "Close this terminal to stop the server."
  wait $SERVER_PID
fi
