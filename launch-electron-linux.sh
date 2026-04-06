#!/usr/bin/env bash
# Team Leader — Launch Native App (Linux)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules/electron" ]; then
  echo "Setup required: run bash install-electron.sh first"
  exit 1
fi

exec npx electron .
