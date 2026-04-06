# Team Leader — DXpedition Logger

Runs on **macOS** and **Linux** from the same codebase. No compilation,
no platform-specific code. Only requires Node.js.

---

## Quick start

### macOS

**Option A — double-click launcher:**
```
Right-click launch-mac.command → Open
```
It installs dependencies on first run, starts the server, and opens
the browser automatically.

**Option B — terminal:**
```bash
npm install      # first time only
node server.js
# then open http://localhost:7375
```

### Linux (DXpedition kit)

```bash
npm install          # first time only
node server.js

# or in kiosk mode (boots directly into full-screen logger):
bash launch-linux.sh --kiosk
```

---

## Something not working?

Run the pre-flight check — it diagnoses every common problem:
```bash
bash check.sh
```

---

## Multi-operator testing

Open **multiple browser tabs** at `http://localhost:7375`.
Each tab is an independent operator station. Log in one tab and
watch it appear instantly in all others. The dupe checker works
across all tabs.

On the actual DXpedition, each laptop connects to the master's IP:
```
http://192.168.1.100:7375    ← master's IP
```

---

## Callsign-field commands

Type in the callsign field and press **Enter**:

| Type this  | Does this                        |
|------------|----------------------------------|
| `SSB`      | Switch to SSB mode               |
| `USB`      | Switch to SSB mode               |
| `LSB`      | Switch to SSB mode               |
| `CW`       | Switch to CW mode                |
| `FT8`      | Switch to FT8/digital mode       |
| `OPON`     | Open operator change dialog      |
| `QRZ`      | Announce to network log          |
| `14225`    | Tune to 14.225 MHz               |
| `7.023`    | Tune to 7.023 MHz                |

---

## Keyboard shortcuts

| Key       | Action                      |
|-----------|-----------------------------|
| `Enter`   | Log QSO (or run command)    |
| `Escape`  | Wipe entry fields           |
| `F1`      | CQ macro                    |
| `F2`      | Exchange macro              |
| `F3`      | TU / sign-off macro         |
| `F4`      | Open OPON dialog            |
| Click QSO | Edit / delete               |

---

## Configuration (config.json)

```json
{
  "callsign": "VK0EK",
  "operatorId": "OP1",
  "operators": ["W6OP", "K3LR", "VK2GR", "JA1YCQ"],
  "clublog": {
    "enabled": false,
    "callsign": "VK0EK",
    "email": "you@example.com",
    "password": "clublog-password",
    "apiKey": "your-api-key"
  },
  "network": {
    "httpPort": 7375,
    "wsPort": 7373
  }
}
```

Set `clublog.enabled` to `true` to stream QSOs live.

---

## CAT / rig control (optional)

**macOS:**
```bash
brew install hamlib
rigctld -m 3073 -r /dev/cu.usbserial-XXXX -s 19200 -T 127.0.0.1 -t 4532
node cat-bridge.js
```

**Linux:**
```bash
sudo apt-get install hamlib-utils
rigctld -m 3073 -r /dev/ttyUSB0 -s 19200 -T 127.0.0.1 -t 4532
node cat-bridge.js
```

Find your rig model number: `rigctl --list | grep -i "your rig"`

Common models:
- IC-7300 → `3073`
- IC-7610 → `3081`
- FT-991A → `135`
- TS-590SG → `2028`
- K3/K3S → `229`

---

## ADIF export

Click the **ADIF** button in the logger, or:
```
http://localhost:7375/api/export.adi
```

---

## Linux boot setup (DXpedition kit)

To make a laptop boot straight into Team Leader:
```bash
sudo bash setup.sh master     # on the master laptop
sudo bash setup.sh operator   # on each operator laptop
```

---

## File layout

```
TeamLeader/
├── server.js          — HTTP + WebSocket + SQLite (Node.js)
├── cat-bridge.js      — CAT control via rigctld (optional)
├── config.json        — all configuration
├── package.json       — Node.js dependencies
├── launch-mac.command — macOS double-click launcher
├── launch-linux.sh    — Linux launcher (normal + kiosk)
├── check.sh           — pre-flight diagnostic
├── setup.sh           — Linux boot/systemd installer
├── teamleader.db      — SQLite log (created on first run)
└── public/
    └── index.html     — the logger UI
```
