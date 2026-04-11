'use strict';
// ── Icom CI-V Bridge ─────────────────────────────────────────────────────────
// Connects to an Icom IC-7610 (or similar) via CI-V over TCP/IP.
// Exposes the same REST API as FlexBridge (/status, /cat/command) so
// server.js can poll and forward commands without knowing the backend.

const net  = require('net');
const http = require('http');

// ── CI-V constants ───────────────────────────────────────────────────────────
const CIV_PREAMBLE = 0xFE;
const CIV_EOM      = 0xFD;
const CIV_OK       = 0xFB;
const CIV_NG       = 0xFA;
const CTRL_ADDR    = 0xE0;

// CI-V command codes
const CMD_SET_FREQ  = 0x05;  // Set frequency (5-byte BCD)
const CMD_READ_FREQ = 0x03;  // Read frequency
const CMD_SET_MODE  = 0x06;  // Set mode + filter
const CMD_READ_MODE = 0x04;  // Read mode

// Mode byte ↔ name mapping
const ICOM_MODE_TO_NAME = {
  0x00: 'LSB', 0x01: 'USB', 0x02: 'AM', 0x03: 'CW',
  0x04: 'RTTY', 0x05: 'FM', 0x07: 'CW-R', 0x08: 'RTTY-R',
  0x17: 'DV',
};
const NAME_TO_ICOM_MODE = {};
for (const [k, v] of Object.entries(ICOM_MODE_TO_NAME)) NAME_TO_ICOM_MODE[v] = parseInt(k);

// TS-2000 mode digit ↔ CI-V mode
const TS2K_TO_ICOM = { '1': 0x00, '2': 0x01, '3': 0x03, '4': 0x05, '5': 0x02, '6': 0x04, '7': 0x07, '9': 0x01 };
const ICOM_TO_TS2K = { 0x00: '1', 0x01: '2', 0x02: '5', 0x03: '3', 0x04: '6', 0x05: '4', 0x07: '7', 0x08: '6' };

// ── BCD helpers ──────────────────────────────────────────────────────────────
function freqToIcomBCD(hz) {
  const s = String(Math.round(hz)).padStart(10, '0');
  const bytes = new Uint8Array(5);
  // 10 digits → 5 bytes, LSB first
  // s = "0014074000"  →  digits [0,0,1,4,0,7,4,0,0,0]
  // byte0 = digits[9]*16 + digits[8]  (1 Hz, 10 Hz)
  // byte1 = digits[7]*16 + digits[6]  (100 Hz, 1 kHz)
  // ...
  for (let i = 0; i < 5; i++) {
    const hi = parseInt(s[9 - i * 2 - 1]) || 0;
    const lo = parseInt(s[9 - i * 2]) || 0;
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}

function icomBCDToFreq(bytes) {
  let hz = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const hi = (bytes[i] >> 4) & 0x0F;
    const lo = bytes[i] & 0x0F;
    hz = hz * 100 + hi * 10 + lo;
  }
  return hz;
}

function modeNameToFlex(name) {
  // Normalise Icom mode names to match what server.js/FlexBridge expects
  return { LSB: 'LSB', USB: 'USB', AM: 'AM', CW: 'CW', FM: 'FM',
           'CW-R': 'CW', RTTY: 'RTTY', 'RTTY-R': 'RTTY', DV: 'FM' }[name] || 'USB';
}

// ── CI-V frame builder / parser ──────────────────────────────────────────────
function buildFrame(toAddr, cmd, data) {
  const frame = [CIV_PREAMBLE, CIV_PREAMBLE, toAddr, CTRL_ADDR, cmd];
  if (data) frame.push(...data);
  frame.push(CIV_EOM);
  return Buffer.from(frame);
}

function extractFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length - 1) {
    // Find preamble
    if (buf[i] !== CIV_PREAMBLE || buf[i + 1] !== CIV_PREAMBLE) { i++; continue; }
    // Find end of frame
    let end = -1;
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === CIV_EOM) { end = j; break; }
    }
    if (end === -1) break; // incomplete frame, keep in buffer
    // Parse: [FE FE to from cmd ...data FD]
    const to   = buf[i + 2];
    const from = buf[i + 3];
    const cmd  = buf[i + 4];
    const data = buf.slice(i + 5, end);
    frames.push({ to, from, cmd, data });
    i = end + 1;
  }
  return { frames, remaining: buf.slice(i) };
}

// ── IcomBridge class ─────────────────────────────────────────────────────────
class IcomBridge {
  constructor(opts) {
    this.radioIp    = opts.radioIp    || '10.0.10.112';
    this.radioPort  = opts.radioPort  || 50001;
    this.statusPort = opts.statusPort || 7377;
    this.civAddr    = parseInt(opts.civAddress) || 0x98;
    this.autoReconnect = opts.autoReconnect !== false;

    this.sock       = null;
    this.rxBuf      = Buffer.alloc(0);
    this.connected  = false;
    this.state      = {
      freq_hz:    14074000,
      tx_freq_hz: 14074000,
      rx_freq_hz: 14074000,
      mode:       'USB',
      mode_byte:  0x01,
      split:      false,
    };
    this.pollTimer    = null;
    this.reconnTimer  = null;
    this.httpServer   = null;
    this._log         = opts.log || console.log;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  start() {
    this._startHTTP();
    this.connect();
    this._log(`[Icom] Bridge starting — radio=${this.radioIp}:${this.radioPort} REST=:${this.statusPort}`);
  }

  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.reconnTimer);
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    if (this.httpServer) { try { this.httpServer.close(); } catch {} }
    this.connected = false;
    this._log('[Icom] Bridge stopped');
  }

  connect() {
    if (this.sock) { try { this.sock.destroy(); } catch {} }
    this.sock = new net.Socket();
    this.rxBuf = Buffer.alloc(0);

    this.sock.connect(this.radioPort, this.radioIp, () => {
      this.connected = true;
      this._log(`[Icom] Connected to IC-7610 at ${this.radioIp}:${this.radioPort}`);
      // Read initial state
      this._sendRead(CMD_READ_FREQ);
      this._sendRead(CMD_READ_MODE);
      // Start polling
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this._poll(), 400);
    });

    this.sock.on('data', (data) => {
      this.rxBuf = Buffer.concat([this.rxBuf, data]);
      const { frames, remaining } = extractFrames(this.rxBuf);
      this.rxBuf = remaining;
      for (const f of frames) this._handleFrame(f);
    });

    this.sock.on('error', (e) => {
      this._log(`[Icom] Socket error: ${e.message}`);
    });

    this.sock.on('close', () => {
      this.connected = false;
      clearInterval(this.pollTimer);
      this._log('[Icom] Disconnected');
      if (this.autoReconnect) {
        this.reconnTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.sock.setTimeout(5000, () => {
      if (!this.connected) {
        this._log('[Icom] Connection timeout');
        this.sock.destroy();
      }
    });
  }

  // ── CI-V I/O ─────────────────────────────────────────────────────────────
  _send(cmd, data) {
    if (!this.sock || !this.connected) return;
    const frame = buildFrame(this.civAddr, cmd, data);
    try { this.sock.write(frame); } catch {}
  }

  _sendRead(cmd) { this._send(cmd); }

  _poll() {
    this._sendRead(CMD_READ_FREQ);
    this._sendRead(CMD_READ_MODE);
  }

  _handleFrame(f) {
    // Only process frames addressed to us (or broadcast) from the radio
    if (f.from !== this.civAddr) return;
    if (f.to !== CTRL_ADDR && f.to !== 0x00) return;

    // OK / NG acknowledgement
    if (f.cmd === CIV_OK || f.cmd === CIV_NG) return;

    // Frequency data (response to read or transceive push)
    if ((f.cmd === CMD_READ_FREQ || f.cmd === CMD_SET_FREQ || f.cmd === 0x00) && f.data.length >= 5) {
      const hz = icomBCDToFreq(f.data.slice(0, 5));
      if (hz > 100000 && hz < 500000000) {
        this.state.freq_hz    = hz;
        this.state.tx_freq_hz = hz;
        this.state.rx_freq_hz = hz;
      }
      return;
    }

    // Mode data (response to read or transceive push)
    if ((f.cmd === CMD_READ_MODE || f.cmd === CMD_SET_MODE || f.cmd === 0x01) && f.data.length >= 1) {
      const modeCode = f.data[0];
      const name = ICOM_MODE_TO_NAME[modeCode];
      if (name) {
        this.state.mode      = modeNameToFlex(name);
        this.state.mode_byte = modeCode;
      }
      return;
    }
  }

  // ── Set commands ─────────────────────────────────────────────────────────
  setFreq(hz) {
    const bcd = freqToIcomBCD(hz);
    this._send(CMD_SET_FREQ, [...bcd]);
    this.state.freq_hz    = hz;
    this.state.tx_freq_hz = hz;
    this.state.rx_freq_hz = hz;
    this._log(`[Icom] Set freq: ${hz} Hz`);
  }

  setMode(modeName) {
    const code = NAME_TO_ICOM_MODE[modeName];
    if (code === undefined) {
      this._log(`[Icom] Unknown mode: ${modeName}`);
      return;
    }
    // Send mode + default filter (0x01 = FIL1)
    this._send(CMD_SET_MODE, [code, 0x01]);
    this.state.mode      = modeNameToFlex(modeName);
    this.state.mode_byte = code;
    this._log(`[Icom] Set mode: ${modeName} (0x${code.toString(16)})`);
  }

  // ── TS-2000 CAT command handler ──────────────────────────────────────────
  handleCat(cmd) {
    cmd = cmd.trim().toUpperCase().replace(/;$/, '');
    if (!cmd) return '';

    // FA — frequency
    if (cmd.startsWith('FA')) {
      if (cmd.length > 2) {
        const hz = parseInt(cmd.slice(2));
        if (!isNaN(hz) && hz > 0) this.setFreq(hz);
        return '';
      }
      return `FA${String(this.state.freq_hz).padStart(11, '0')};`;
    }

    // FB — VFO-B
    if (cmd.startsWith('FB')) {
      if (cmd.length > 2) return '';
      return `FB${String(this.state.rx_freq_hz).padStart(11, '0')};`;
    }

    // MD — mode
    if (cmd.startsWith('MD')) {
      if (cmd.length > 2) {
        const ts2k = cmd[2];
        const icomCode = TS2K_TO_ICOM[ts2k];
        if (icomCode !== undefined) {
          const name = ICOM_MODE_TO_NAME[icomCode] || 'USB';
          this.setMode(name);
        }
        return '';
      }
      const ts2k = ICOM_TO_TS2K[this.state.mode_byte] || '2';
      return `MD${ts2k};`;
    }

    // IF — transceiver info
    if (cmd === 'IF') {
      const freq  = String(this.state.freq_hz).padStart(11, '0');
      const mode  = ICOM_TO_TS2K[this.state.mode_byte] || '2';
      const split = this.state.split ? '1' : '0';
      return `IF${freq}     +0000000000${mode}00${split}0000;`;
    }

    if (cmd === 'ID') return 'ID020;';
    if (cmd.startsWith('AI')) return 'AI0;';
    if (cmd === 'TX' || cmd === 'RX') return '';
    if (cmd === 'PS') return 'PS1;';

    return '?;';
  }

  // ── REST API ─────────────────────────────────────────────────────────────
  _startHTTP() {
    this.httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.statusPort}`);
      const path = url.pathname;

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(200); res.end(); return;
      }

      const sendJSON = (code, obj) => {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      };

      if (req.method === 'GET' && path === '/status') {
        sendJSON(200, {
          connected:        this.connected,
          radio_ip:         this.radioIp,
          radio_model:      'IC-7610',
          protocol_version: 'CI-V',
          freq_hz:          this.state.freq_hz,
          tx_freq_hz:       this.state.tx_freq_hz,
          rx_freq_hz:       this.state.rx_freq_hz,
          mode:             this.state.mode,
          split:            this.state.split,
        });
        return;
      }

      if (req.method === 'POST' && path === '/cat/command') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { command } = JSON.parse(body);
            if (!command) { sendJSON(400, { ok: false, error: 'No command' }); return; }
            const resp = this.handleCat(command);
            sendJSON(200, { ok: true, response: resp });
          } catch (e) {
            sendJSON(400, { ok: false, error: e.message });
          }
        });
        return;
      }

      sendJSON(404, { error: 'not found' });
    });

    this.httpServer.listen(this.statusPort, '127.0.0.1', () => {
      this._log(`[Icom] REST API on http://127.0.0.1:${this.statusPort}`);
    });
  }
}

module.exports = { IcomBridge };
