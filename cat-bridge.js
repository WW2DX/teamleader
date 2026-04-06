/**
 * Team Leader — CAT Bridge
 *
 * Supports two backends:
 *   1. rigctld (Hamlib)  — standard rigs via TCP Hamlib protocol
 *   2. FlexBridge        — FlexRadio 6000 series via REST + TS-2000 CAT
 *
 * Exposes rig state to browser UI on ws://localhost:7374
 */

'use strict';

const net       = require('net');
const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');

// ── Load config ───────────────────────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch {}

const cat          = config.cat || {};
const CAT_WS_PORT  = parseInt(config.network?.catPort) || 7374;
const POLL_MS      = 400;
const MAX_FAILS    = 5;

// Detect mode: flex if rigType is 'flex' or flexbridge.enabled is true
const IS_FLEX = cat.rigType === 'flex' || !!(cat.flexbridge?.enabled);

const RIGCTLD_HOST = cat.rigctldHost || '127.0.0.1';
const RIGCTLD_PORT = parseInt(cat.rigctldPort) || 4532;

const FB_STATUS_PORT = parseInt(cat.flexbridge?.statusPort) || 7376;
const FB_CAT_PORT    = parseInt(cat.flexbridge?.catTcpPort) || 4532;
const FB_HOST        = '127.0.0.1';

// ── State ─────────────────────────────────────────────────────────────────────
let lastFreq   = null;
let lastMode   = null;
let lastRxFreq = null;
let rigOnline  = false;
let failCount  = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function hzToMHz(hz) { return (parseFloat(hz) / 1e6).toFixed(3); }

function freqToBand(freqMHz) {
  const f = parseFloat(freqMHz);
  if (f >= 1.8   && f < 2.0)    return '160M';
  if (f >= 3.5   && f < 4.0)    return '80M';
  if (f >= 5.3   && f < 5.4)    return '60M';
  if (f >= 7.0   && f < 7.3)    return '40M';
  if (f >= 10.1  && f < 10.15)  return '30M';
  if (f >= 14.0  && f < 14.35)  return '20M';
  if (f >= 18.068 && f < 18.168) return '17M';
  if (f >= 21.0  && f < 21.45)  return '15M';
  if (f >= 24.89 && f < 24.99)  return '12M';
  if (f >= 28.0  && f < 29.7)   return '10M';
  if (f >= 50.0  && f < 54.0)   return '6M';
  return 'GEN';
}

function normaliseMode(raw) {
  const m = (raw || '').split('\n')[0].trim().toUpperCase();
  if (m === 'USB' || m === 'LSB') return 'SSB';
  if (m.startsWith('CW'))         return 'CW';
  if (m === 'PKTUSB' || m === 'PKTLSB' || m === 'DIGU' || m === 'DIGL') return 'FT8';
  if (m === 'AM')  return 'AM';
  if (m === 'FM')  return 'FM';
  return m || 'SSB';
}

// Map FlexRadio SmartSDR mode strings → normalised
function normaliseFlexMode(raw) {
  const m = (raw || '').toUpperCase();
  if (m === 'USB' || m === 'LSB')  return 'SSB';
  if (m === 'CW'  || m === 'CWL')  return 'CW';
  if (m === 'DIGU'|| m === 'DIGL' || m === 'FT8' || m === 'RTTY') return 'FT8';
  if (m === 'AM')   return 'AM';
  if (m === 'FM')   return 'FM';
  if (m === 'NFM')  return 'FM';
  return 'SSB';
}

// ── rigctld backend ───────────────────────────────────────────────────────────
function queryRig(command, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(RIGCTLD_PORT, RIGCTLD_HOST);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    sock.on('connect', () => sock.write(command + '\n'));
    sock.on('data',    d  => { buf += d.toString(); });
    sock.on('end',     ()  => { clearTimeout(timer); resolve(buf.trim()); });
    sock.on('error',   e  => { clearTimeout(timer); reject(e); });
  });
}

async function pollRigctld() {
  try {
    const [freqRaw, modeRaw, rxFreqRaw] = await Promise.all([
      queryRig('f'), queryRig('m'), queryRig('i'),
    ]);
    const txFreq = hzToMHz(freqRaw);
    const rxFreq = hzToMHz(rxFreqRaw);
    const mode   = normaliseMode(modeRaw);
    const band   = freqToBand(txFreq);
    const isSplit = Math.abs(parseFloat(txFreq) - parseFloat(rxFreq)) > 0.001;
    const effectiveRxFreq = isSplit ? rxFreq : txFreq;
    applyState(txFreq, effectiveRxFreq, mode, band, isSplit, true);
  } catch {
    handleFail();
  }
}

// ── FlexBridge backend ────────────────────────────────────────────────────────
// Poll FlexBridge's REST /status endpoint — it has the full rig state already
// parsed from SmartSDR, no need to re-parse CAT commands ourselves.
function httpGet(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const req = http.get({ host: FB_HOST, port, path, timeout: timeoutMs }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end',  () => { clearTimeout(timer); resolve(buf); });
    });
    req.on('error',   e => { clearTimeout(timer); reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function pollFlexBridge() {
  try {
    const raw  = await httpGet(FB_STATUS_PORT, '/status');
    const data = JSON.parse(raw);

    if (!data.connected) {
      // FlexBridge running but not connected to radio yet
      handleFail();
      return;
    }

    // FlexBridge state has freq_hz, rx_freq_hz, mode, split
    const txMHz = (data.tx_freq_hz / 1e6).toFixed(3);
    const rxMHz = (data.rx_freq_hz / 1e6).toFixed(3);
    const mode  = normaliseFlexMode(data.mode);
    const band  = freqToBand(txMHz);
    const isSplit = data.split && Math.abs(parseFloat(txMHz) - parseFloat(rxMHz)) > 0.001;

    applyState(txMHz, isSplit ? rxMHz : txMHz, mode, band, isSplit, true);

  } catch {
    handleFail();
  }
}

// Send a CAT command to FlexBridge's TCP CAT server
function flexCatCmd(cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(FB_CAT_PORT, FB_HOST);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 1500);
    sock.on('connect', () => sock.write(cmd));
    sock.on('data',    d  => { buf += d.toString(); if (buf.includes(';')) { clearTimeout(timer); sock.destroy(); resolve(buf); } });
    sock.on('error',   e  => { clearTimeout(timer); reject(e); });
  });
}

// ── Shared state application ──────────────────────────────────────────────────
function applyState(txFreq, rxFreq, mode, band, isSplit, online) {
  const changed = txFreq !== lastFreq || mode !== lastMode || rxFreq !== lastRxFreq;
  if (!rigOnline || changed) {
    lastFreq   = txFreq;
    lastMode   = mode;
    lastRxFreq = rxFreq;
    rigOnline  = true;
    failCount  = 0;
    broadcast({ type: 'CAT_STATE', freq: txFreq, rxFreq, band, mode, split: isSplit, online: true });
    if (changed) console.log(`[CAT] ${txFreq} MHz${isSplit ? ' / RX ' + rxFreq : ''} ${mode} ${band}`);
  }
}

function handleFail() {
  failCount++;
  if (failCount >= MAX_FAILS && rigOnline) {
    rigOnline = false;
    const src = IS_FLEX ? `FlexBridge at :${FB_STATUS_PORT}` : `rigctld at ${RIGCTLD_HOST}:${RIGCTLD_PORT}`;
    broadcast({ type: 'CAT_STATE', freq: lastFreq, rxFreq: lastRxFreq, band: '??', mode: lastMode, online: false });
    console.warn(`[CAT] ${src} unreachable — retrying...`);
  }
}

// ── Poll dispatcher ───────────────────────────────────────────────────────────
function poll() {
  if (IS_FLEX) return pollFlexBridge();
  else         return pollRigctld();
}

// ── WebSocket server → browser ────────────────────────────────────────────────
const clients = new Set();
const catWss  = new WebSocket.Server({ port: CAT_WS_PORT });

catWss.on('connection', ws => {
  clients.add(ws);

  // Send current state immediately on connect
  if (lastFreq !== null) {
    ws.send(JSON.stringify({
      type:   'CAT_STATE',
      freq:   lastFreq,
      rxFreq: lastRxFreq,
      band:   freqToBand(lastFreq),
      mode:   lastMode,
      online: rigOnline,
    }));
  }

  // Handle commands from the browser (tune / mode change)
  ws.on('message', async raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'SET_FREQ') {
        const hz = Math.round(parseFloat(msg.freq) * 1e6);
        if (IS_FLEX) {
          await flexCatCmd(`FA${String(hz).padStart(11, '0')};`);
        } else {
          await queryRig(`F ${hz}`);
        }
        console.log(`[CAT] ← SET_FREQ ${msg.freq} MHz`);
      }

      if (msg.type === 'SET_MODE') {
        if (IS_FLEX) {
          const ts2k = { SSB: '2', CW: '3', FT8: '9', AM: '5', FM: '4' }[msg.mode] || '2';
          await flexCatCmd(`MD${ts2k};`);
        } else {
          const rigMode = { SSB: 'USB', CW: 'CW', FT8: 'PKTUSB', AM: 'AM', FM: 'FM' }[msg.mode] || msg.mode;
          await queryRig(`M ${rigMode} 0`);
        }
        console.log(`[CAT] ← SET_MODE ${msg.mode}`);
      }

    } catch (e) {
      console.warn('[CAT] Command error:', e.message);
    }
  });

  ws.on('close',  () => clients.delete(ws));
  ws.on('error',  () => clients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
setInterval(poll, POLL_MS);
poll();

console.log('');
console.log('  Team Leader — CAT Bridge');
console.log('  ─────────────────────────────────────');
if (IS_FLEX) {
  console.log(`  Mode     : FlexBridge (REST poll)`);
  console.log(`  Status   : http://${FB_HOST}:${FB_STATUS_PORT}/status`);
  console.log(`  CAT TCP  : ${FB_HOST}:${FB_CAT_PORT}`);
} else {
  console.log(`  Mode     : rigctld`);
  console.log(`  rigctld  : ${RIGCTLD_HOST}:${RIGCTLD_PORT}`);
}
console.log(`  Browser  : ws://localhost:${CAT_WS_PORT}`);
console.log(`  Polling  : every ${POLL_MS}ms`);
console.log('');

process.on('SIGINT', () => {
  console.log('\n[CAT] Shutting down...');
  catWss.close();
  process.exit(0);
});
