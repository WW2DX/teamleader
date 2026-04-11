# Changelog

All notable changes to Team Leader are documented here.

## [1.10.1] — 2026-04-11

### Fixed
- `launch-mac.command` now launches Electron native app instead of the
  old browser-only mode. Falls back to browser if Electron isn't installed.

## [1.10.0] — 2026-04-11

### Added
- **Multi-model Icom support** — Settings page now has a Radio Model
  dropdown: IC-7610, IC-7300/MKII, IC-9700, IC-705, IC-7851, IC-R8600.
  CI-V address auto-sets when you pick a model.
- `--model` argument for icom-bridge.py, passed through to icom-lan
  for model-specific command support.

### Changed
- Settings tab renamed from "Icom IC-7610" to "Icom (Network)" to
  reflect broader radio support.
- README updated to list all supported Icom models.

## [1.9.1] — 2026-04-11

### Fixed
- server.js crashed on `/api/icom/status` — leftover reference to
  `_icomBridge` (old in-process variable) instead of
  `global._icomBridgeProc` (child process).
- Icom bridge process getting port 7377 "Address already in use" from
  stale processes not cleaned up between restarts.

## [1.9.0] — 2026-04-11

### Changed
- **Icom bridge rewritten as Python** using the `icom-lan` library, which
  implements the full Icom proprietary UDP protocol (authentication, token
  renewal, keepalive, CI-V framing). The old Node.js TCP bridge is replaced
  by `icom-bridge.py` — spawned as a child process like FlexBridge.
- Settings page now includes **Username** and **Password** fields for IC-7610
  network authentication.
- server.js spawns `icom-bridge.py` via Python 3.14 venv at
  `/tmp/icom-venv` where `icom-lan` is installed.

### Fixed
- IC-7610 connection: the radio uses a proprietary UDP protocol (not TCP
  CI-V), requiring a multi-step handshake with credential encryption. The
  `icom-lan` library handles this correctly.

## [1.8.2] — 2026-04-11

### Fixed
- Settings page crash "Cannot access '_icomPollTimer' before initialization"
  when switching to the Icom tab — variable was declared after first use due
  to `let` temporal dead zone. Moved declaration to top of script.
- Added CHANGELOG.md for tracking all releases.

## [1.8.1] — 2026-04-11

### Fixed
- Blue screen after Check for Updates — old server process held ports during
  restart. Now calls `stopServer()` and waits 1s before relaunching.

## [1.8.0] — 2026-04-11

### Added
- **Icom IC-7610 CI-V bridge** — direct network control via the radio's
  built-in LAN interface. No rigctld, no USB cable, no extra software.
  Frequency/mode tracking and control from the call box, same as FlexRadio.
- **Icom tab in Settings** — configure radio IP, CI-V port, connect/disconnect
  with live status display.
- `getActiveBridgePort()` abstraction — server.js routes commands to whichever
  bridge (FlexBridge or Icom) is active.
- `/api/icom/start`, `/api/icom/stop`, `/api/icom/status` REST endpoints.

### Changed
- SET_FREQ, SET_MODE, CWX, and `/api/fb/*` proxy now route through
  `getActiveBridgePort()` instead of hardcoding FlexBridge port.

## [1.7.0] — 2026-04-11

### Added
- **One-click update** — Logger menu → Check for Updates pulls from GitHub,
  runs `npm install` if needed, and restarts the app.
- **Larger top bar** — title 18px, stat values 22px, labels 10px, height 54px.

### Fixed
- `server.js` version was hardcoded as `1.6.16`. Now reads from `package.json`.

## [1.6.5] — 2026-04-10

### Added
- **Band conflict protection** — three-layer TX inhibit (UI banner, CW block,
  hardware MOX disable) when two operators share a band.
- **Standalone FlexBridge** — registers as `client program FlexBridge` with
  SmartSDR and auto-creates slice 0 when no GUI client is running.
- **TCI v1.9 WebSocket server** — JTDX / MSHV / WSJT-X Improved connect
  directly to FlexRadio for CAT + audio, no virtual audio driver needed.
- TCI RX audio gain slider in Settings (−40…+20 dB).
- REST fallback for SET_FREQ/SET_MODE when browser WebSocket is down.

### Fixed
- Network bar shows operator callsigns (OPON) instead of DXpedition call.
- PEER_OP_STATE updates both callsign and operatorId in discoveredPeers.
- Operator status panel: remote peers marked offline instead of deleted on
  momentary disconnect; filter relaxed to show entries with valid callsigns.
- `broadcastOpState()` fires immediately on connect (was 600ms delay).
- Heartbeat reduced from 60s to 15s.
- Graceful shutdown kills FlexBridge/cat-bridge/WSJT-X child processes.
- FlexBridge detects and kills stale orphaned processes on startup.
- Electron app name and About panel show "Team Leader" not "Electron".

### Changed
- Network bar redesigned as wrapping pill-chip layout for 20+ nodes.
- Inbound peer connections proactively push PEER_LIST and operator states.
- `getLocalOpStates()` includes txFreq/rxFreq/mode for full peer sync.
- BlackHole audio sink disabled by default (broken on macOS 26); opt-in
  via `--enable-blackhole`.

## [1.0.0] — 2026-04-06

### Added
- Initial release — multi-operator peer-mesh DXpedition logger.
- Real-time QSO sync across stations via WebSocket peer mesh.
- Auto-discovery via mDNS.
- FlexRadio SmartSDR integration via FlexBridge.
- CW ESM mode with F-key macros.
- WSJT-X UDP integration.
- ClubLog live streaming.
- USB drive auto-backup.
- Electron native app for macOS and Linux.
