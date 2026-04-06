#!/bin/bash
# Team Leader — CAT double-click launcher for macOS
# Right-click → Open the first time (Gatekeeper will block double-click on first run)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check Hamlib is installed
if ! command -v rigctld &>/dev/null; then
  osascript -e 'display alert "Hamlib not installed" message "CAT control requires Hamlib. Install it by running this in Terminal:\n\nbrew install hamlib\n\nIf you don'\''t have Homebrew, get it from https://brew.sh" as critical'
  exit 1
fi

# Check CAT is enabled in config
CAT_ENABLED=$(python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config.json')); print(d.get('cat',{}).get('enabled',False))" 2>/dev/null)
if [ "$CAT_ENABLED" != "True" ]; then
  osascript -e 'display alert "CAT is disabled" message "Enable CAT in Team Leader Settings:\n\n1. Open http://localhost:7375/settings.html\n2. Turn on CAT Control\n3. Enter your rig model and serial port\n4. Click Save Settings\n5. Try launching CAT again" as informational'
  open "http://localhost:7375/settings.html"
  exit 0
fi

# Open a Terminal window and run the CAT startup script
osascript <<APPLESCRIPT
tell application "Terminal"
    activate
    set w to do script "cd '$SCRIPT_DIR' && bash start-cat.sh"
    set custom title of w to "Team Leader — CAT"
end tell
APPLESCRIPT
