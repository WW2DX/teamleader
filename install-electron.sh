#!/usr/bin/env bash
# Team Leader — Native App Installer
# Run once to install Electron dependencies, then use build-mac.sh or build-linux.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Team Leader — Native App Setup                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
NODE_VER=$(node --version)
echo "✓ Node.js $NODE_VER"

# ── Install dependencies ──────────────────────────────────────────────────────
echo ""
echo "Installing dependencies (this downloads Electron ~120MB)..."
npm install
echo "✓ Dependencies installed"

# ── Generate .icns for macOS (if on macOS) ───────────────────────────────────
if [[ "$(uname)" == "Darwin" ]]; then
  echo ""
  echo "Generating macOS icon (.icns)..."
  ICONSET="electron/build/icon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    scp_file="electron/build/icon_${size}.png"
    if [[ -f "$scp_file" ]]; then
      cp "$scp_file" "$ICONSET/icon_${size}x${size}.png"
      cp "$scp_file" "$ICONSET/icon_${size}x${size}@2x.png" 2>/dev/null || true
    fi
  done
  iconutil -c icns "$ICONSET" -o "electron/build/icon.icns" 2>/dev/null && \
    echo "✓ icon.icns generated" || \
    echo "⚠ iconutil failed — app will run without .icns (optional)"
  rm -rf "$ICONSET"
fi

# ── Make launchers executable ────────────────────────────────────────────────
chmod +x TeamLeader.command 2>/dev/null || true
chmod +x TeamLeader.sh      2>/dev/null || true
chmod +x launch-electron-mac.command 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✓ Setup complete!                              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  ▶ LAUNCH: Double-click TeamLeader.command"
echo "    (or: npm run electron)"
echo ""
echo "  Build distributable packages:"
echo "    macOS:  npm run build:mac"
echo "    Linux:  npm run build:linux"
echo ""
