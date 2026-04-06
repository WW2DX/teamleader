#!/bin/bash
# Team Leader — CAT Startup Script
#
# This script reads your config.json, builds the correct rigctld command,
# starts rigctld, then starts the CAT bridge.
#
# Run it in a separate terminal window alongside node server.js:
#   bash start-cat.sh
#
# Or use the --background flag to run both processes silently:
#   bash start-cat.sh --background

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
fail() { echo -e "  ${RED}✗${NC}  $1"; }
info() { echo -e "  ${YELLOW}→${NC}  $1"; }

echo ""
echo -e "${BOLD}  Team Leader — CAT Setup${NC}"
echo "  ──────────────────────────────────"
echo ""

# ── Check Hamlib is installed ─────────────────────────────────────────────────
if ! command -v rigctld &>/dev/null; then
  fail "rigctld not found"
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    info "Install Hamlib: brew install hamlib"
  else
    info "Install Hamlib: sudo apt install hamlib-utils"
  fi
  echo ""
  exit 1
fi
ok "rigctld found: $(rigctld --version 2>&1 | head -1)"

# ── Read config ───────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG" ]; then
  fail "config.json not found at $CONFIG"
  exit 1
fi

CAT_ENABLED=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('enabled',False))" 2>/dev/null)
if [ "$CAT_ENABLED" != "True" ]; then
  echo -e "  ${YELLOW}CAT is disabled in config.json${NC}"
  echo ""
  echo "  Enable it in Settings (http://localhost:7375/settings.html)"
  echo "  or edit config.json and set:  \"cat\": { \"enabled\": true, ... }"
  echo ""
  exit 0
fi

RIG_MODEL=$(python3  -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('rigModel',''))"    2>/dev/null)
SERIAL_PORT=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('serialPort',''))"  2>/dev/null)
BAUD_RATE=$(python3   -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('baudRate',19200))"  2>/dev/null)
RIGCTLD_HOST=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('rigctldHost','127.0.0.1'))" 2>/dev/null)
RIGCTLD_PORT=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('cat',{}).get('rigctldPort',4532))"        2>/dev/null)

# ── Validate required fields ──────────────────────────────────────────────────
if [ -z "$RIG_MODEL" ]; then
  fail "No rig model set in config.json"
  echo ""
  info "Find your model: rigctl --list | grep -i \"your rig name\""
  echo "  Then set it in Settings or in config.json under cat.rigModel"
  echo ""
  echo "  Common models:"
  echo "    IC-7300   = 3073"
  echo "    IC-7610   = 3081"
  echo "    IC-705    = 3086"
  echo "    FT-991A   = 135"
  echo "    FT-DX10   = 1035"
  echo "    TS-590SG  = 2028"
  echo "    TS-890S   = 2044"
  echo "    K3/K3S    = 229"
  echo "    KX3       = 234"
  echo "    FLEX-6600 = 2062"
  echo ""
  exit 1
fi

if [ -z "$SERIAL_PORT" ]; then
  fail "No serial port set in config.json"
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    info "Available serial ports on this Mac:"
    ls /dev/cu.usb* /dev/cu.USB* 2>/dev/null | sed 's/^/    /'
    [ $? -ne 0 ] && echo "    (none found — is the USB cable connected?)"
  else
    info "Available serial ports on this Linux:"
    ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | sed 's/^/    /'
    [ $? -ne 0 ] && echo "    (none found — is the USB cable connected?)"
  fi
  echo ""
  echo "  Set it in Settings or in config.json under cat.serialPort"
  echo ""
  exit 1
fi

# ── Check serial port exists ──────────────────────────────────────────────────
if [ ! -e "$SERIAL_PORT" ]; then
  fail "Serial port not found: $SERIAL_PORT"
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    info "Available ports:"
    ls /dev/cu.usb* /dev/cu.USB* 2>/dev/null | sed 's/^/    /' || echo "    (none)"
  else
    info "Available ports:"
    ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null | sed 's/^/    /' || echo "    (none)"
    echo ""
    info "If your port exists but is inaccessible, add yourself to the dialout group:"
    echo "    sudo usermod -aG dialout \$USER  (then log out and back in)"
  fi
  echo ""
  exit 1
fi
ok "Serial port: $SERIAL_PORT"

# ── Kill any existing rigctld on this port ────────────────────────────────────
EXISTING=$(lsof -ti tcp:$RIGCTLD_PORT 2>/dev/null)
if [ -n "$EXISTING" ]; then
  info "Stopping existing rigctld on port $RIGCTLD_PORT..."
  kill $EXISTING 2>/dev/null
  sleep 0.5
fi

# ── Build and show the rigctld command ────────────────────────────────────────
RIGCTLD_CMD="rigctld -m $RIG_MODEL -r $SERIAL_PORT -s $BAUD_RATE -T $RIGCTLD_HOST -t $RIGCTLD_PORT"
echo ""
echo -e "  ${BOLD}rigctld command:${NC}"
echo "  $RIGCTLD_CMD"
echo ""

# ── Start rigctld ─────────────────────────────────────────────────────────────
$RIGCTLD_CMD &
RIGCTLD_PID=$!
sleep 1

# Verify it started
if ! kill -0 $RIGCTLD_PID 2>/dev/null; then
  fail "rigctld failed to start"
  echo ""
  info "Check that:"
  echo "    - The rig is powered on"
  echo "    - The USB cable is connected"
  echo "    - The baud rate ($BAUD_RATE) matches the rig's CI-V / CAT setting"
  echo "    - No other software is using $SERIAL_PORT"
  echo ""
  exit 1
fi
ok "rigctld started (PID $RIGCTLD_PID)"

# Test the connection
TEST=$(echo "f" | nc -w 1 $RIGCTLD_HOST $RIGCTLD_PORT 2>/dev/null)
if [ -n "$TEST" ]; then
  FREQ_MHZ=$(python3 -c "print(f'{float('$TEST')/1e6:.3f}')" 2>/dev/null)
  ok "Rig responding — frequency: ${FREQ_MHZ} MHz"
else
  echo -e "  ${YELLOW}⚠${NC}  rigctld started but rig not responding yet (normal — may take a moment)"
fi

# ── Kill any existing CAT bridge ──────────────────────────────────────────────
CAT_PORT=$(python3 -c "import json; d=json.load(open('$CONFIG')); print(d.get('network',{}).get('catPort',7374))" 2>/dev/null)
EXISTING_CAT=$(lsof -ti tcp:$CAT_PORT 2>/dev/null)
if [ -n "$EXISTING_CAT" ]; then
  info "Stopping existing CAT bridge on port $CAT_PORT..."
  kill $EXISTING_CAT 2>/dev/null
  sleep 0.3
fi

# ── Start CAT bridge ──────────────────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Starting CAT bridge...${NC}"
echo ""

if [ "${1}" = "--background" ]; then
  node "$SCRIPT_DIR/cat-bridge.js" &
  CAT_PID=$!
  ok "CAT bridge started (PID $CAT_PID)"
  echo ""
  ok "CAT is running. The logger at http://localhost:7375 will now track your rig."
  echo ""
  echo "  To stop CAT: kill $RIGCTLD_PID $CAT_PID"
else
  # Trap Ctrl+C to cleanly kill rigctld too
  trap "echo ''; echo 'Stopping CAT...'; kill $RIGCTLD_PID 2>/dev/null; exit 0" SIGINT SIGTERM
  node "$SCRIPT_DIR/cat-bridge.js"
  # If cat-bridge exits, kill rigctld too
  kill $RIGCTLD_PID 2>/dev/null
fi
