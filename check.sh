#!/bin/bash
# Team Leader — pre-flight check
# Run this if something isn't working. It checks everything and tells you
# exactly what to fix.

PASS=0
FAIL=0
WARN=0

green='\033[0;32m'
red='\033[0;31m'
yellow='\033[1;33m'
bold='\033[1m'
nc='\033[0m'

ok()   { echo -e "  ${green}OK${nc}    $1"; ((PASS++)); }
fail() { echo -e "  ${red}FAIL${nc}  $1"; ((FAIL++)); }
warn() { echo -e "  ${yellow}WARN${nc}  $1"; ((WARN++)); }

echo ""
echo -e "${bold}  Team Leader — Pre-flight Check${nc}"
echo "  ──────────────────────────────────"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── OS ────────────────────────────────────────────────────────────────────────
echo -e "  ${bold}System${nc}"
OS=$(uname -s)
case "$OS" in
  Darwin) ok "macOS $(sw_vers -productVersion)" ;;
  Linux)  ok "Linux ($(uname -r))" ;;
  *)      warn "Unknown OS: $OS" ;;
esac

ARCH=$(uname -m)
ok "Architecture: $ARCH"
echo ""

# ── Node.js ───────────────────────────────────────────────────────────────────
echo -e "  ${bold}Node.js${nc}"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo $NODE_VER | cut -c2- | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 16 ]; then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js $NODE_VER — version 16+ required. Install from https://nodejs.org"
  fi
else
  fail "Node.js not found"
  if [ "$OS" = "Darwin" ]; then
    echo "       Fix: brew install node"
    echo "       Or: https://nodejs.org"
  else
    echo "       Fix: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
    echo "            sudo apt-get install -y nodejs"
  fi
fi

if command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  fail "npm not found (usually installed with Node.js)"
fi
echo ""

# ── Dependencies ──────────────────────────────────────────────────────────────
echo -e "  ${bold}Dependencies${nc}"
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  ok "node_modules present"
  for pkg in sql.js ws uuid; do
    if [ -d "$SCRIPT_DIR/node_modules/$pkg" ]; then
      ok "$pkg installed"
    else
      fail "$pkg missing — run: npm install"
    fi
  done
else
  fail "node_modules not found — run: npm install"
fi
echo ""

# ── Project files ─────────────────────────────────────────────────────────────
echo -e "  ${bold}Project files${nc}"
for f in server.js config.json public/index.html; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    ok "$f"
  else
    fail "$f missing"
  fi
done
echo ""

# ── Config ────────────────────────────────────────────────────────────────────
echo -e "  ${bold}config.json${nc}"
if [ -f "$SCRIPT_DIR/config.json" ]; then
  CALLSIGN=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('callsign','MISSING'))" 2>/dev/null)
  if [ "$CALLSIGN" = "NOCALL" ] || [ -z "$CALLSIGN" ]; then
    warn "Callsign is '$CALLSIGN' — edit config.json and set your callsign"
  else
    ok "Callsign: $CALLSIGN"
  fi

  HTTP_PORT=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('network',{}).get('httpPort',7375))" 2>/dev/null || echo 7375)
  ok "HTTP port: $HTTP_PORT"
  WS_PORT=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('network',{}).get('wsPort',7373))" 2>/dev/null || echo 7373)
  ok "WS port:   $WS_PORT"

  CL_ENABLED=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('clublog',{}).get('enabled',False))" 2>/dev/null)
  if [ "$CL_ENABLED" = "True" ]; then
    ok "Clublog: enabled"
    CL_EMAIL=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('clublog',{}).get('email',''))" 2>/dev/null)
    if [ -z "$CL_EMAIL" ]; then
      warn "Clublog email not set in config.json"
    fi
  else
    ok "Clublog: disabled (enable in config.json when ready)"
  fi
fi
echo ""

# ── Ports ─────────────────────────────────────────────────────────────────────
echo -e "  ${bold}Ports${nc}"
HTTP_PORT=${HTTP_PORT:-7375}
WS_PORT=${WS_PORT:-7373}

check_port() {
  local port=$1
  local name=$2
  if lsof -ti tcp:$port &>/dev/null 2>&1 || ss -tlnp "sport = :$port" 2>/dev/null | grep -q LISTEN; then
    warn "Port $port ($name) already in use — stop the existing process first"
  else
    ok "Port $port ($name) is free"
  fi
}

check_port $HTTP_PORT "HTTP"
check_port $WS_PORT   "WebSocket"
check_port 7374       "CAT bridge"
echo ""

# ── CAT / Hamlib ──────────────────────────────────────────────────────────────
echo -e "  ${bold}CAT (optional)${nc}"
if command -v rigctld &>/dev/null; then
  ok "rigctld found: $(rigctld --version 2>&1 | head -1)"
else
  warn "rigctld not found — CAT control will not work"
  if [ "$OS" = "Darwin" ]; then
    echo "       Fix: brew install hamlib"
  else
    echo "       Fix: sudo apt-get install hamlib-utils"
  fi
fi

CAT_ENABLED=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('cat',{}).get('enabled',False))" 2>/dev/null)
if [ "$CAT_ENABLED" = "True" ]; then
  RIGCTLD_PORT=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('cat',{}).get('rigctldPort',4532))" 2>/dev/null || echo 4532)
  if nc -z 127.0.0.1 $RIGCTLD_PORT 2>/dev/null; then
    ok "rigctld responding on port $RIGCTLD_PORT"
  else
    warn "CAT enabled in config but rigctld not responding on port $RIGCTLD_PORT"
    echo "       Start with: ./start-rigctld.sh"
  fi
fi
echo ""

# ── Network (multi-station) ───────────────────────────────────────────────────
echo -e "  ${bold}Network${nc}"
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ip route get 1 2>/dev/null | awk '{print $7; exit}' || echo "unknown")
ok "Local IP: $LOCAL_IP"
echo "       Other stations connect to: ws://$LOCAL_IP:$WS_PORT"
echo "       Other stations open:       http://$LOCAL_IP:$HTTP_PORT"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "  ──────────────────────────────────"
if [ $FAIL -eq 0 ]; then
  echo -e "  ${green}${bold}All checks passed${nc} ($PASS OK, $WARN warnings)"
  echo ""
  echo "  Start the logger:"
  if [ "$OS" = "Darwin" ]; then
    echo "    node server.js"
    echo "    (or double-click launch-mac.command)"
  else
    echo "    node server.js"
    echo "    (or: bash launch-linux.sh)"
  fi
else
  echo -e "  ${red}${bold}$FAIL check(s) failed${nc} — fix the issues above before starting"
fi
echo ""
