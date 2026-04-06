# Team Leader — Native App

Team Leader runs as both a web app (open `http://localhost:7375` in any browser) 
and as a native desktop app on macOS and Linux using Electron.

## Quick Start

### 1. One-time setup
```bash
bash install-electron.sh
```
This installs Electron (~120MB download) and generates the macOS icon.

### 2. Run the native app

**macOS:** Double-click `launch-electron-mac.command`  
**Linux:** `bash launch-electron-linux.sh`  
**Either:** `npm run electron`

The app starts the Team Leader server internally — no separate terminal needed.

---

## Build Distributable Packages

```bash
# macOS — produces .dmg and .zip (Intel + Apple Silicon)
npm run build:mac

# Linux — produces .AppImage, .deb, .tar.gz
npm run build:linux

# Both platforms
npm run build:all
```

Packages appear in the `dist/` folder.

### macOS requirements
- Xcode Command Line Tools: `xcode-select --install`
- For code signing: Apple Developer account (optional — app works unsigned for local use)

### Linux requirements  
- `rpm` for .rpm builds: `sudo apt install rpm`
- No other requirements for AppImage or .deb

---

## Native App Features

- **System tray** — Team Leader lives in the menu bar; double-click to show
- **Native menus** — Cmd+, for Settings, Cmd+1/2 for Logger/Stats
- **About dialog** — Help → About Team Leader
- **Open in Browser** — Help → Open in Browser (for multi-window use)
- **Auto-server** — the web server starts and stops with the app

---

## Web App (no install)

The web interface still works independently:
```bash
node server.js
# Open http://localhost:7375
```

---

## File Locations (native app)

| File | Location |
|------|----------|
| Config | `config.json` (same folder as app) |
| Database | `teamleader.db` (same folder) |
| Logs | Terminal / system log |
