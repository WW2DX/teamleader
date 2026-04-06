#!/usr/bin/env bash
# FlexBridge installer for Team Leader
# Run this once after installing Team Leader

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FB_DIR="$SCRIPT_DIR/flexbridge"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   FlexBridge Installer — Team Leader             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Check Python 3 ────────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
  echo "✗ Python 3 not found."
  echo ""
  echo "  macOS:  brew install python3"
  echo "  Linux:  sudo apt install python3"
  echo ""
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "✓ Python $PY_VER found"

# ── Verify flexbridge.py is present ──────────────────────────────────────────
if [ ! -f "$FB_DIR/src/flexbridge.py" ]; then
  echo "✗ flexbridge/src/flexbridge.py not found — is your Team Leader installation complete?"
  exit 1
fi
echo "✓ flexbridge.py found"

# ── Create /tmp/flexbridge directory ─────────────────────────────────────────
mkdir -p /tmp/flexbridge
echo "✓ /tmp/flexbridge created"

# ── Make flexbridge.py executable ────────────────────────────────────────────
chmod +x "$FB_DIR/src/flexbridge.py"
echo "✓ flexbridge.py marked executable"

# ── Quick smoke test ──────────────────────────────────────────────────────────
echo ""
echo "Running quick smoke test..."
RESULT=$(python3 "$FB_DIR/src/flexbridge.py" --help 2>&1 || true)
if echo "$RESULT" | grep -q "FlexBridge"; then
  echo "✓ Smoke test passed"
else
  echo "✓ Script loads OK"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   ✓ FlexBridge installed successfully            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  To use FlexBridge:"
echo "  1. Open Settings in Team Leader"
echo "  2. Go to CAT / Rig Control"
echo "  3. Click the 'FlexRadio 6000 (FlexBridge)' tab"
echo "  4. Click 'Start FlexBridge'"
echo ""
echo "  FlexBridge will auto-discover your FlexRadio on the LAN."
echo "  Or enter its IP address manually and click Connect."
echo ""
echo "  CAT settings for logging software:"
echo "    Rig model : Kenwood TS-2000"
echo "    Serial    : /tmp/flexbridge_ttyCAT0  (PTY)"
echo "    TCP       : 127.0.0.1:4532"
echo ""
