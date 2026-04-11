/**
 * Team Leader v1.2.0 — Peer Mesh Server
 * by WW2DX
 *
 * Topology: every station is equal. No master/node.
 * Each PC runs independently, peers auto-discovered via mDNS UDP multicast.
 *
 * Resilience:
 *   1. Local SQLite — written after every QSO
 *   2. USB backup — every 10 QSOs + ADIF every 5 min
 *   3. Peer sync — QSOs replicated to all peers, queued when offline
 *   4. Clublog — each station uploads only its own QSOs (by source_station)
 *   5. First-run wizard — browser redirects to /setup.html if unconfigured
 */

'use strict';

const VERSION = require('./package.json').version;

// Detect if running inside Electron native app
const IS_ELECTRON = !!process.env.ELECTRON_RUN;

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const dgram     = require('dgram');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const initSqlJs = require('sql.js');

// ── Config ─────────────────────────────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return { callsign:'VK0EK', operatorId:'OP1', operators:[], network:{}, backup:{}, clublog:{}, cat:{} }; }
}

let config = loadConfig();

const HTTP_PORT = config.network?.httpPort || 7375;
const WS_PORT   = config.network?.wsPort   || 7373;
const PEER_PORT = config.network?.peerPort || 7374;
const DB_FILE   = path.join(__dirname, 'teamleader.db');

function isConfigured() {
  return !!(config._configured ||
    (config.callsign && config.callsign !== 'NOCALL' && config.callsign !== 'VK0EK' &&
     config.operatorId && config.operatorId !== 'OP1'));
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets))
    for (const a of iface)
      if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

// ── USB ────────────────────────────────────────────────────────────────────────
const BACKUP_CFG        = config.backup || {};
const USB_BACKUP_ENABLED = BACKUP_CFG.usb !== false;
const USB_INTERVAL_QSOs  = BACKUP_CFG.usbEveryQSOs || 10;
const ADIF_INTERVAL_MS   = (BACKUP_CFG.adifMinutes || 5) * 60 * 1000;

function findUSBDrives() {
  const drives = [];
  try {
    if (process.platform === 'darwin') {
      for (const v of fs.readdirSync('/Volumes')) {
        const mp = `/Volumes/${v}`;
        try { fs.accessSync(mp, fs.constants.W_OK); if (v !== 'Macintosh HD' && !v.startsWith('.')) drives.push(mp); } catch {}
      }
    } else {
      for (const base of ['/media', '/mnt']) {
        if (!fs.existsSync(base)) continue;
        for (const u of fs.readdirSync(base)) {
          const up = path.join(base, u);
          try {
            if (fs.statSync(up).isDirectory()) {
              try { for (const s of fs.readdirSync(up)) { const sp = path.join(up,s); try { fs.accessSync(sp,fs.constants.W_OK); drives.push(sp); } catch {} } }
              catch { try { fs.accessSync(up,fs.constants.W_OK); drives.push(up); } catch {} }
            }
          } catch {}
        }
      }
    }
  } catch {}
  return drives;
}

function getUSBBackupPath() {
  if (!USB_BACKUP_ENABLED) return null;
  const drives = findUSBDrives();
  if (!drives.length) return null;
  for (const d of drives) { const tl = path.join(d,'TeamLeader'); if (fs.existsSync(tl)) return tl; }
  try { const tl = path.join(drives[0],'TeamLeader'); fs.mkdirSync(tl,{recursive:true}); return tl; } catch {}
  return null;
}

function getUSBStatus() {
  const drives = findUSBDrives();
  return { enabled:USB_BACKUP_ENABLED, drives, backupPath:getUSBBackupPath(), hasUSB:drives.length>0 };
}

// ── Database ───────────────────────────────────────────────────────────────────
let db;
let qsosSinceLastUSBBackup = 0;

function saveDb() {
  try {
    const data = Buffer.from(db.export());
    fs.writeFileSync(DB_FILE, data);
    if (++qsosSinceLastUSBBackup >= USB_INTERVAL_QSOs) { qsosSinceLastUSBBackup=0; backupToUSB(data); }
  } catch(e) { console.error('[DB] Save error:', e.message); }
}

function backupToUSB(dbData) {
  const usbPath = getUSBBackupPath(); if (!usbPath) return;
  try {
    const buf = dbData || Buffer.from(db.export());
    const ts  = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    fs.writeFileSync(path.join(usbPath,'teamleader.db'), buf);
    const sd = path.join(usbPath,'snapshots'); fs.mkdirSync(sd,{recursive:true});
    const snaps = fs.readdirSync(sd).filter(f=>f.endsWith('.db')).sort();
    while (snaps.length >= 24) fs.unlinkSync(path.join(sd,snaps.shift()));
    fs.writeFileSync(path.join(sd,`${ts}.db`), buf);
    console.log(`[Backup] USB: ${usbPath}`);
  } catch(e) { console.warn('[Backup] USB failed:', e.message); }
}

function backupADIFToUSB() {
  const adif = buildADIF();
  const fn   = `${config.callsign||'teamleader'}_log.adif`;
  try { fs.writeFileSync(path.join(__dirname, fn), adif); } catch {}
  const usbPath = getUSBBackupPath();
  if (usbPath) { try { fs.writeFileSync(path.join(usbPath,fn), adif); console.log('[Backup] ADIF USB'); } catch {} }
}

function dbRun(sql, p=[]) { db.run(sql, p); saveDb(); }
function dbGet(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function dbAll(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const r=[]; while(s.step()) r.push(s.getAsObject()); s.free(); return r; }

function initSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS qsos (
    id             TEXT PRIMARY KEY,
    seq            INTEGER,
    source_station TEXT,
    operator       TEXT NOT NULL,
    callsign       TEXT NOT NULL,
    freq           REAL, band TEXT, mode TEXT,
    rst_sent TEXT, rst_rcvd TEXT, exchange TEXT, name TEXT,
    logged_at TEXT NOT NULL,
    dupe_flag INTEGER DEFAULT 0, clublog_ok INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_dupe    ON qsos(callsign,band,mode,deleted);
  CREATE INDEX IF NOT EXISTS idx_seq     ON qsos(seq);
  CREATE INDEX IF NOT EXISTS idx_source  ON qsos(source_station);
  CREATE INDEX IF NOT EXISTS idx_clublog ON qsos(clublog_ok,source_station,deleted);`);
  try { db.run(`ALTER TABLE qsos ADD COLUMN source_station TEXT`); } catch {}
  saveDb();
}

function insertQSO(q) {
  dbRun(`INSERT OR IGNORE INTO qsos
    (id,seq,source_station,operator,callsign,freq,band,mode,rst_sent,rst_rcvd,exchange,name,logged_at,dupe_flag)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [q.id, q.seq, q.source_station||config.operatorId,
     q.operator, q.callsign, q.freq||null, q.band||null, q.mode||null,
     q.rst_sent||null, q.rst_rcvd||null, q.exchange||null, q.name||null,
     q.logged_at, q.dupe_flag||0]);
}

function updateQSO(q) {
  dbRun(`UPDATE qsos SET callsign=?,rst_sent=?,rst_rcvd=?,exchange=?,name=? WHERE id=?`,
    [q.callsign, q.rst_sent||null, q.rst_rcvd||null, q.exchange||null, q.name||null, q.id]);
}

function softDelete(id) { dbRun(`UPDATE qsos SET deleted=1 WHERE id=?`,[id]); }

function isDupe(callsign, band, mode) {
  const r = dbGet(`SELECT 1 as f FROM qsos WHERE callsign=? AND band=? AND mode=? AND deleted=0 LIMIT 1`,
    [callsign.toUpperCase(), band, mode]);
  return !!(r&&r.f);
}

function getAll()    { return dbAll(`SELECT * FROM qsos WHERE deleted=0 ORDER BY seq ASC`); }
function getMaxSeq() { const r=dbGet(`SELECT COALESCE(MAX(seq),0) as m FROM qsos`); return r?(Number(r.m)||0):0; }

// ── DXCC prefix extraction (simplified — good enough for achievement tracking) ──
function dxccPrefix(callsign) {
  if (!callsign) return '?';
  const c = callsign.replace(/\/(P|M|MM|AM)$/i, '').split('/');
  // If there's a portable suffix that looks like a prefix, use it
  if (c.length > 1 && c[1].length <= 4 && /^[A-Z0-9]+$/.test(c[1])) {
    const m = c[1].match(/^([A-Z]+\d?)/);
    if (m) return m[1];
  }
  const base = c[0];
  const m = base.match(/^(\d[A-Z]+\d*|[A-Z]+\d+)/);
  return m ? m[1] : base.slice(0, 3);
}

// Track which achievements have fired this server session so they don't repeat.
// Keys: "100:20M", "100:40M", "5BDXCC", etc.
const firedAchievements = new Set();

// The classic 5-band DXCC bands
const FIVE_BAND_DXCC = ['80M','40M','20M','15M','10M'];

// Returns an array of achievement objects to broadcast (usually 0 or 1, but
// could be 2 if a band-100 also completes 5BDXCC in the same QSO).
function checkDXCCAchievements(band) {
  if (!band) return [];
  const results = [];

  // Count unique DXCC prefixes worked on this band (non-dupes only)
  const rows = dbAll(
    `SELECT DISTINCT callsign FROM qsos WHERE band=? AND dupe_flag=0 AND deleted=0`,
    [band]
  );
  const prefixCount = new Set(rows.map(r => dxccPrefix(r.callsign))).size;

  // Fire exactly once when a band crosses 100
  const DXCC_THRESHOLD = 10;  // lower for testing; set to 100 for production
  const bandKey = `dxcc${DXCC_THRESHOLD}:${band}`;
  if (prefixCount >= DXCC_THRESHOLD && !firedAchievements.has(bandKey)) {
    firedAchievements.add(bandKey);
    results.push({ achievementType: 'DXCC100_BAND', band, count: DXCC_THRESHOLD });
  }

  // Check 5BDXCC — DXCC_THRESHOLD+ unique DXCC on each of the 5 classic bands
  if (!firedAchievements.has('5BDXCC')) {
    const achieved5B = FIVE_BAND_DXCC.every(b => {
      const r = dbAll(
        `SELECT DISTINCT callsign FROM qsos WHERE band=? AND dupe_flag=0 AND deleted=0`, [b]
      );
      return new Set(r.map(x => dxccPrefix(x.callsign))).size >= DXCC_THRESHOLD;
    });
    if (achieved5B) {
      firedAchievements.add('5BDXCC');
      results.push({ achievementType: '5BDXCC' });
    }
  }

  return results;
}

function getStats() {
  const qsos=getAll(); const byBand={},byMode={},byOp={};
  qsos.forEach(q=>{byBand[q.band]=(byBand[q.band]||0)+1;byMode[q.mode]=(byMode[q.mode]||0)+1;byOp[q.operator]=(byOp[q.operator]||0)+1;});
  const dr=dbGet(`SELECT COUNT(*) as n FROM qsos WHERE dupe_flag=1 AND deleted=0`);
  return {total:qsos.length,dupes:dr?dr.n:0,byBand,byMode,byOp};
}

let seqCounter = 0;
function nextSeq() { return ++seqCounter; }

// ── ADIF ───────────────────────────────────────────────────────────────────────
function buildADIF() {
  const qsos   = getAll();
  const header = `Team Leader Export — ${config.callsign}\n<ADIF_VER:5>3.1.1\n<PROGRAMID:11>TeamLeader\n<EOH>\n\n`;
  return header + qsos.map(q => {
    const dt=new Date(q.logged_at);
    const date=dt.toISOString().slice(0,10).replace(/-/g,'');
    const time=dt.toISOString().slice(11,16).replace(':','');
    return [`<CALL:${q.callsign.length}>${q.callsign}`,
      `<QSO_DATE:8>${date}`,`<TIME_ON:4>${time}`,
      `<BAND:${(q.band||'').length}>${q.band||''}`,
      `<MODE:${(q.mode||'').length}>${q.mode||''}`,
      q.freq?`<FREQ:${String(q.freq).length}>${q.freq}`:'',
      `<RST_SENT:${(q.rst_sent||'').length}>${q.rst_sent||''}`,
      `<RST_RCVD:${(q.rst_rcvd||'').length}>${q.rst_rcvd||''}`,
      `<SRX_STRING:${(q.exchange||'').length}>${q.exchange||''}`,
      `<APP_DXLOG_OP:${q.operator.length}>${q.operator}`,
      `<APP_DXLOG_STN:${(q.source_station||'').length}>${q.source_station||''}`,
      q.dupe_flag?`<APP_DXLOG_DUPE:1>Y`:'',`<EOR>`
    ].filter(Boolean).join(' ');
  }).join('\n');
}

// ── Clublog — only own QSOs (by source_station) ────────────────────────────────
async function postClublog(qso) {
  const cl = config.clublog;
  if (!cl?.enabled || !cl.email) return;
  if (qso.source_station && qso.source_station !== config.operatorId) return;
  const dt=new Date(qso.logged_at);
  const date=dt.toISOString().slice(0,10).replace(/-/g,'');
  const time=dt.toISOString().slice(11,16).replace(':','');
  const adif=[`<CALL:${qso.callsign.length}>${qso.callsign}`,
    `<QSO_DATE:8>${date}`,`<TIME_ON:4>${time}`,
    `<BAND:${(qso.band||'').length}>${qso.band||''}`,
    `<MODE:${(qso.mode||'').length}>${qso.mode||''}`,`<EOR>`].join(' ');
  const body=new URLSearchParams({email:cl.email,password:cl.password,callsign:cl.callsign,api:cl.apiKey,adif}).toString();
  return new Promise((resolve,reject)=>{
    const req=https.request('https://clublog.org/realtime.php',
      {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'}},
      r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>d.trim()==='OK'?resolve():reject(new Error(d)));});
    req.on('error',reject);req.write(body);req.end();
  });
}

// ── Solar ──────────────────────────────────────────────────────────────────────
let solarCache = { data:null, ts:0 };

function fetchSolarData() {
  return new Promise((resolve,reject)=>{
    const req=https.get('https://www.hamqsl.com/solarxml.php',{timeout:8000},res=>{
      let body=''; res.on('data',c=>body+=c);
      res.on('end',()=>{
        try {
          const rawA=(body.match(/<aindex>([^<]+)</)   ||[])[1];
          const rawK=(body.match(/<kindex>([^<]+)</)   ||[])[1];
          const rawKnt=(body.match(/<kindexnt>([^<]+)</)||[])[1];
          const sfi=(body.match(/<solarflux>([\d.]+)/)||[])[1];
          const sunspots=(body.match(/<sunspots>([\d.]+)/)||[])[1];
          const xray=(body.match(/<xray>([^<]+)</)    ||[])[1];
          const aNum=rawA?rawA.match(/([\d.]+)/):null;
          const kRaw=rawK||rawKnt||''; const kNum=kRaw.match(/([\d.]+)/);
          console.log(`[Solar] SFI=${sfi} A=${rawA} K=${rawK}`);
          if (sfi) resolve({sfi:parseInt(sfi),a:aNum?parseInt(aNum[1]):null,
            k:kNum?Math.round(parseFloat(kNum[1])):null,
            xray:xray&&xray.trim()!=='No Data'?xray.trim():null,
            sunspots:sunspots?parseInt(sunspots):null,source:'hamqsl'});
          else reject(new Error('parse failed'));
        } catch(e){reject(e);}
      });
    });
    req.on('error',reject); req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});
  }).catch(()=>{
    const fetchJSON=url=>new Promise((res,rej)=>{
      https.get(url,{timeout:6000},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b));}catch(e){rej(e);}});}).on('error',rej);
    });
    return Promise.allSettled([
      fetchJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      fetchJSON('https://services.swpc.noaa.gov/json/geomag/3-day-indices.json'),
      fetchJSON('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json'),
    ]).then(([kR,aR,sR])=>{
      let k=null,a=null,sfi=null;
      if(kR.status==='fulfilled'&&Array.isArray(kR.value)&&kR.value.length>1){const l=kR.value[kR.value.length-1];k=l?Math.round(parseFloat(l[1])):null;}
      if(aR.status==='fulfilled'&&Array.isArray(aR.value)&&aR.value.length>1){const l=aR.value[aR.value.length-1];a=l&&l.a_running?Math.round(parseFloat(l.a_running)):null;}
      if(sR.status==='fulfilled'&&Array.isArray(sR.value)&&sR.value.length>0){const l=sR.value[sR.value.length-1];sfi=l&&l['f10.7']?Math.round(parseFloat(l['f10.7'])):null;}
      return {sfi,a,k,source:'noaa'};
    });
  });
}

function scheduleSolar() {
  const doFetch=()=>fetchSolarData()
    .then(d=>{solarCache={data:d,ts:Date.now()};console.log(`[Solar] SFI=${d.sfi} A=${d.a} K=${d.k}`);broadcastToBrowsers({type:'SOLAR_UPDATE',solar:d});})
    .catch(e=>console.warn('[Solar]',e.message));
  doFetch(); setInterval(doFetch,60*60*1000);
}

// ── Icom CI-V bridge (Python child process, same pattern as FlexBridge) ──────
function startIcomBridge() {
  const ic = config.cat?.icom || {};
  // Kill existing
  if (global._icomBridgeProc) {
    try { global._icomBridgeProc.kill('SIGTERM'); } catch {}
    global._icomBridgeProc = null;
  }
  const { execSync: eSync } = require('child_process');
  const shellPath = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  // Find python3 with icom-lan installed (check venv first, then system)
  let py3 = '';
  const venvPy = '/tmp/icom-venv/bin/python3.14';
  if (fs.existsSync(venvPy)) { py3 = venvPy; }
  else {
    try { py3 = eSync(`${shellPath} -l -c "which python3"`, {timeout:3000,encoding:'utf8'}).trim(); } catch {}
    if (!py3) {
      const home = process.env.HOME || require('os').homedir();
      for (const p of [path.join(home,'.pyenv','shims','python3'),'/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3']) {
        if (fs.existsSync(p)) { py3 = p; break; }
      }
    }
  }
  if (!py3) py3 = 'python3';

  const script = path.join(__dirname, 'icom-bridge.py');
  if (!fs.existsSync(script)) {
    console.error('[Icom] icom-bridge.py not found');
    return;
  }

  const bridgeArgs = [script,
    '--radio',    ic.radioIp    || '10.0.10.112',
    '--port',     String(ic.radioPort  || 50001),
    '--username', ic.username   || '',
    '--password', ic.password   || '',
    '--civ-addr', '0x' + (ic.civAddress || 0x98).toString(16),
    '--status-port', String(ic.statusPort || 7377),
  ];

  console.log(`[Icom] Python: ${py3}`);
  console.log(`[Icom] Script: ${script}`);
  console.log(`[Icom] Args: --radio ${ic.radioIp} --port ${ic.radioPort}`);

  const proc = require('child_process').spawn(py3, bridgeArgs, {
    cwd: __dirname, detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => console.log('[Icom]', d.toString().trimEnd()));
  proc.stderr.on('data', d => console.log('[Icom] ERR', d.toString().trimEnd()));
  proc.on('error', e => console.error('[Icom] SPAWN ERROR:', e.message));
  proc.on('exit', (code, sig) => { console.log(`[Icom] exited code=${code} signal=${sig}`); global._icomBridgeProc = null; });
  global._icomBridgeProc = proc;
  console.log(`[Icom] Bridge started PID ${proc.pid}`);
  setTimeout(() => startFlexBridgePoll(true), 3000);
}

function stopIcomBridge() {
  if (global._icomBridgeProc) {
    try { global._icomBridgeProc.kill('SIGTERM'); } catch {}
    global._icomBridgeProc = null;
  }
}

// Returns the REST API port for whichever bridge is active
function getActiveBridgePort() {
  const rigType = config.cat?.rigType;
  if (rigType === 'icom' || config.cat?.icom?.enabled) {
    return parseInt(config.cat?.icom?.statusPort) || 7377;
  }
  return parseInt(config.cat?.flexbridge?.statusPort) || 7376;
}

// ── FlexBridge CAT poller ──────────────────────────────────────────────────────
let _fbLastFreq=null,_fbLastMode=null,_fbLastRx=null,_fbOnline=false,_fbFailCount=0;
const FB_MAX_FAILS=5;

function freqToBandServer(mhz){
  const f=parseFloat(mhz);
  if(f>=1.8&&f<2.0)return'160M'; if(f>=3.5&&f<4.0)return'80M';
  if(f>=5.3&&f<5.4)return'60M';  if(f>=7.0&&f<7.3)return'40M';
  if(f>=10.1&&f<10.15)return'30M';if(f>=14.0&&f<14.35)return'20M';
  if(f>=18.068&&f<18.168)return'17M';if(f>=21.0&&f<21.45)return'15M';
  if(f>=24.89&&f<24.99)return'12M';if(f>=28.0&&f<29.7)return'10M';
  if(f>=50.0&&f<54.0)return'6M'; return'GEN';
}

function normaliseFlexMode(raw){
  const m=(raw||'').toUpperCase();
  if(m==='USB'||m==='LSB')return'SSB';
  if(m==='CW'||m==='CWL')return'CW';
  if(m==='DIGU'||m==='DIGL'||m==='FT8'||m==='RTTY')return'FT8';
  if(m==='AM')return'AM';
  if(m==='FM'||m==='NFM')return'FM';
  return'SSB';
}

function pollFlexBridge(){
  const port=getActiveBridgePort();
  const req=http.get({host:'127.0.0.1',port,path:'/status',timeout:1200},res=>{
    let buf='';
    res.on('data',d=>{buf+=d;});
    res.on('end',()=>{
      try{
        const data=JSON.parse(buf);
        if(!data.connected){
          if(_fbOnline){_fbOnline=false;broadcastToBrowsers({type:'CAT_STATE',online:false,freq:_fbLastFreq,band:'??',mode:_fbLastMode});}
          _fbFailCount=0; return;
        }
        const txMHz=(data.tx_freq_hz/1e6).toFixed(3);
        const rxMHz=(data.rx_freq_hz/1e6).toFixed(3);
        const mode=normaliseFlexMode(data.mode);
        const band=freqToBandServer(txMHz);
        const split=data.split&&Math.abs(parseFloat(txMHz)-parseFloat(rxMHz))>0.001;
        const rxFreq=split?rxMHz:txMHz;
        if(!_fbOnline||txMHz!==_fbLastFreq||mode!==_fbLastMode||rxFreq!==_fbLastRx){
          const changed=txMHz!==_fbLastFreq||mode!==_fbLastMode;
          _fbLastFreq=txMHz;_fbLastMode=mode;_fbLastRx=rxFreq;
          _fbOnline=true;_fbFailCount=0;
          broadcastToBrowsers({type:'CAT_STATE',freq:txMHz,rxFreq,band,mode,split,online:true});
          if(changed)console.log(`[FlexBridge CAT] ${txMHz} MHz ${mode} ${band}${split?' SPLIT RX '+rxMHz:''}`);
        }
      }catch(e){_onFbFail();}
    });
  });
  req.on('error',_onFbFail);
  req.on('timeout',()=>{req.destroy();_onFbFail();});
}

function _onFbFail(){
  _fbFailCount++;
  if(_fbFailCount>=FB_MAX_FAILS&&_fbOnline){
    _fbOnline=false;
    broadcastToBrowsers({type:'CAT_STATE',online:false,freq:_fbLastFreq,band:'??',mode:_fbLastMode});
    console.warn('[FlexBridge CAT] Cannot reach FlexBridge REST API');
  }
}

let _fbPollTimer=null;
function startFlexBridgePoll(force){
  if(_fbPollTimer){clearInterval(_fbPollTimer);_fbPollTimer=null;}
  // Check config unless forced (force=true when called from /api/flexbridge/start)
  if(!force){
    const fb=config.cat?.flexbridge||{};
    const isFlexMode=config.cat?.rigType==='flex'||!!fb.enabled;
    if(!isFlexMode)return;
  }
  console.log('[FlexBridge CAT] Starting poll...');
  _fbFailCount=0;_fbOnline=false;_fbLastFreq=null;_fbLastMode=null;_fbLastRx=null;
  pollFlexBridge();
  _fbPollTimer=setInterval(pollFlexBridge,400);
}

function stopFlexBridgePoll(){
  if(_fbPollTimer){clearInterval(_fbPollTimer);_fbPollTimer=null;}
  if(_fbOnline){_fbOnline=false;broadcastToBrowsers({type:'CAT_STATE',online:false,freq:_fbLastFreq,band:'??',mode:_fbLastMode});}
}

// ── CWX helper — send text to FlexBridge CWX endpoint ─────────────────────────
// Track last sent CW speed to avoid redundant speed commands
function sendCWX(text) {
  // Send CW text only — speed is managed separately via sendCWXSpeed()
  const port = getActiveBridgePort();
  const body = JSON.stringify({ text });
  const req = http.request({
    host:'127.0.0.1', port, path:'/cwx/send',
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
  }, res => { res.resume(); });
  req.on('error', e => console.warn('[CWX send]', e.message));
  req.setTimeout(2000, ()=>req.destroy());
  req.write(body); req.end();
  console.log(`[CWX] → "${text}"`);
}

function sendCWXSpeed(wpm) {
  const w = parseInt(wpm) || 25;
  // Keep in-memory config in sync so /api/config returns correct speed
  if (!config.cw) config.cw = {};
  config.cw.speed = w;
  const port = getActiveBridgePort();
  const body = JSON.stringify({ wpm: w });
  const req = http.request({
    host:'127.0.0.1', port, path:'/cwx/speed',
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
  }, res => {
    let rb=''; res.on('data',d=>rb+=d);
    res.on('end',()=>console.log(`[CWX] Speed → ${w} wpm  (FlexBridge: ${rb.slice(0,40)})`));
  });
  req.on('error', e => console.warn('[CWX speed error]', e.message));
  req.setTimeout(2000, ()=>req.destroy());
  req.write(body); req.end();
  console.log(`[CWX] Setting speed to ${w} wpm`);
}

function clearCWX() {
  const port = getActiveBridgePort();
  const req = http.request({
    host:'127.0.0.1', port, path:'/cwx/clear',
    method:'POST', headers:{'Content-Type':'application/json','Content-Length':2}
  }, res => { res.resume(); });
  req.on('error', ()=>{});
  req.write('{}'); req.end();
}

// ── WSJT-X UDP listener ────────────────────────────────────────────────────────
// WSJT-X sends QSO Logged datagrams (type 12) to UDP port 2237
// We parse them and inject into the Team Leader log
let _wsjtUdpServer = null;

function startWsjtListener() {
  const port = parseInt(config.wsjt?.udpPort) || 2237;
  if (_wsjtUdpServer) { try { _wsjtUdpServer.close(); } catch {} }

  _wsjtUdpServer = dgram.createSocket('udp4');

  _wsjtUdpServer.on('message', (msg) => {
    try {
      const qso = parseWsjtQsoLogged(msg);
      if (!qso) return;
      console.log(`[WSJT-X] QSO: ${qso.callsign} ${qso.band} ${qso.mode}`);
      // Inject into log same as a browser-logged QSO
      qso.id = uuidv4();
      qso.seq = nextSeq();
      qso.source_station = config.operatorId;
      qso.dupe_flag = isDupe(qso.callsign, qso.band, qso.mode) ? 1 : 0;
      insertQSO(qso);
      bcastAll({ type:'QSO_NEW', qso });
      broadcastToPeers({ type:'PEER_QSO', qso });
      if (!qso.dupe_flag) postClublog(qso).catch(()=>{});
    } catch(e) { console.warn('[WSJT-X] Parse error:', e.message); }
  });

  _wsjtUdpServer.on('error', e => console.warn('[WSJT-X] UDP error:', e.message));

  _wsjtUdpServer.bind(port, () => {
    console.log(`[WSJT-X] Listening for QSO datagrams on UDP port ${port}`);
  });
}

function parseWsjtQsoLogged(buf) {
  // WSJT-X UDP protocol: all messages start with magic 0xADBCCBDA + schema + type
  // Type 12 = QSO Logged
  if (buf.length < 8) return null;
  const magic = buf.readUInt32BE(0);
  if (magic !== 0xADBCCBDA) return null;
  // schema = buf.readUInt32BE(4) — skip
  const type = buf.readUInt32BE(8);
  if (type !== 12) return null; // only handle QSO Logged

  let offset = 12;

  // Read pascal-style utf8 string (4-byte length + bytes)
  function readStr() {
    if (offset + 4 > buf.length) return '';
    const len = buf.readUInt32BE(offset); offset += 4;
    if (len === 0xFFFFFFFF || len === 0) return '';
    if (offset + len > buf.length) return '';
    const str = buf.slice(offset, offset + len).toString('utf8');
    offset += len;
    return str;
  }

  function readU32() {
    if (offset + 4 > buf.length) return 0;
    const v = buf.readUInt32BE(offset); offset += 4; return v;
  }

  function readU8() {
    if (offset + 1 > buf.length) return 0;
    const v = buf.readUInt8(offset); offset += 1; return v;
  }

  function readQDateTime() {
    // QDateTime: julian day (8 bytes int64), ms since midnight (4 bytes uint32), timespec (1 byte)
    if (offset + 13 > buf.length) { offset += 13; return new Date().toISOString(); }
    const jdHi = buf.readUInt32BE(offset);
    const jdLo = buf.readUInt32BE(offset + 4);
    offset += 8;
    const ms = buf.readUInt32BE(offset); offset += 4;
    const _ts = readU8(); // timespec
    // Julian day to JS Date: JD 2440588 = 1970-01-01
    const jd = jdHi * 4294967296 + jdLo;
    const epoch = (jd - 2440588) * 86400000 + ms;
    return new Date(epoch).toISOString();
  }

  const _id       = readStr();  // client id
  const dateTime  = readQDateTime();
  const dxCall    = readStr();  // DX callsign
  const dxGrid    = readStr();
  const txFreqHz  = readU32() * 1.0; // dial freq Hz (for older format) — actually u64 but use lo 32 for now
  // Some versions send txFreq as 8-byte double — try reading remaining fields defensively
  const mode      = readStr();
  const rstSent   = readStr();
  const rstRcvd   = readStr();
  const txPower   = readStr();
  const comments  = readStr();
  const name      = readStr();
  // skip optional fields
  const opCall    = readStr();  // operator callsign

  if (!dxCall) return null;

  // Determine band from config or from freq
  const freqMHz = txFreqHz / 1e6;
  const band = freqToBandServer(freqMHz.toFixed(3)) || currentBandFromMode(mode);

  const wsjtMode = mode === 'FT8' ? 'FT8' : mode === 'FT4' ? 'FT8' : 'FT8';

  return {
    callsign:   dxCall.toUpperCase(),
    freq:       parseFloat(freqMHz.toFixed(3)),
    band:       band,
    mode:       wsjtMode,
    rst_sent:   rstSent || '-10',
    rst_rcvd:   rstRcvd || '-12',
    exchange:   comments || '',
    name:       name || '',
    logged_at:  dateTime,
    operator:   config.operatorId || 'OP1',
  };
}

function currentBandFromMode(mode) {
  // Fallback if freq is 0 — use last known band from CAT
  return _fbLastFreq ? freqToBandServer(_fbLastFreq) : '20M';
}

// ── SCP ────────────────────────────────────────────────────────────────────────
const SCP_FILE='MASTER.SCP', SCP_URL='http://www.supercheckpartial.com/MASTER.SCP';
let scpLines=0;

function scheduleSCP() {
  if (fs.existsSync(SCP_FILE)) {
    scpLines=fs.readFileSync(SCP_FILE,'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).length;
    console.log(`[SCP] Loaded ${scpLines.toLocaleString()} callsigns`);
    if (Date.now()-fs.statSync(SCP_FILE).mtimeMs<30*24*60*60*1000) return;
  }
  console.log('[SCP] Downloading MASTER.SCP...');
  const file=fs.createWriteStream(SCP_FILE+'.tmp');
  http.get(SCP_URL,{timeout:30000},res=>{
    if(res.statusCode!==200){console.warn('[SCP] HTTP '+res.statusCode);return;}
    res.pipe(file);
    file.on('finish',()=>file.close(()=>{
      fs.renameSync(SCP_FILE+'.tmp',SCP_FILE);
      scpLines=fs.readFileSync(SCP_FILE,'utf8').split('\n').filter(l=>l.trim()&&!l.startsWith('#')).length;
      console.log(`[SCP] Downloaded ${scpLines.toLocaleString()} callsigns`);
    }));
  }).on('error',e=>console.warn('[SCP]',e.message));
}

// ── mDNS auto-discovery ───────────────────────────────────────────────────────
const MDNS_ADDR   = '224.0.0.251';
const MDNS_PORT   = 5354;
const discoveredPeers = new Map(); // ip -> { operatorId, callsign, peerPort, lastSeen }
const peerConnections = new Map(); // ip -> WebSocket
const peerQueues      = new Map(); // ip -> [queued message strings]

function startMDNS() {
  const sock     = dgram.createSocket({ type:'udp4', reuseAddr:true });
  const localIP  = getLocalIP();

  sock.on('error', e=>console.warn('[mDNS]', e.message));
  sock.on('message', (msg, rinfo)=>{
    if (rinfo.address === localIP) return;
    try {
      const data = JSON.parse(msg.toString());
      if (data.type !== 'teamleader-announce') return;
      const ip    = rinfo.address;
      const isNew = !discoveredPeers.has(ip);
      discoveredPeers.set(ip, {
        operatorId: data.operatorId,
        callsign:   data.callsign,
        peerPort:   data.peerPort || PEER_PORT,
        lastSeen:   Date.now(),
      });
      if (isNew) { console.log(`[mDNS] Found peer: ${data.operatorId} @ ${ip}`); connectToPeer(ip, data.peerPort||PEER_PORT); }
      else discoveredPeers.get(ip).lastSeen = Date.now();
    } catch {}
  });

  sock.bind(MDNS_PORT, ()=>{
    try { sock.addMembership(MDNS_ADDR); } catch(e) { console.warn('[mDNS] Multicast failed:', e.message); }
    sock.setMulticastTTL(2);
    try { sock.setMulticastLoopback(false); } catch {}
  });

  const announceMsg = ()=>Buffer.from(JSON.stringify({
    type:'teamleader-announce', operatorId:config.operatorId,
    callsign:config.callsign, peerPort:PEER_PORT, version:VERSION,
  }));

  const doAnnounce = ()=>{ const m=announceMsg(); sock.send(m,0,m.length,MDNS_PORT,MDNS_ADDR,()=>{}); };
  doAnnounce();
  setInterval(doAnnounce, 5000);

  // Clean up timed-out peers
  setInterval(()=>{
    const now=Date.now();
    for (const [ip,peer] of discoveredPeers) {
      if (now-peer.lastSeen>30000) { console.log(`[mDNS] Peer timeout: ${peer.operatorId} @ ${ip}`); discoveredPeers.delete(ip); broadcastPeerList(); }
    }
  }, 10000);

  // Manual peers from config as fallback
  if (Array.isArray(config.peers)) {
    config.peers.forEach(ip=>{ if(ip&&ip!==localIP&&!discoveredPeers.has(ip)) setTimeout(()=>connectToPeer(ip,PEER_PORT),2000); });
  }

  console.log(`[mDNS] Announcing on ${MDNS_ADDR}:${MDNS_PORT}`);
}

// ── Peer connections ───────────────────────────────────────────────────────────
function connectToPeer(ip, port) {
  if (peerConnections.has(ip) && peerConnections.get(ip).readyState === WebSocket.OPEN) return;
  const url = `ws://${ip}:${port}`;
  console.log(`[Peer] Connecting → ${url}`);
  let ws;
  try { ws = new WebSocket(url, { handshakeTimeout:5000 }); }
  catch(e) { console.warn(`[Peer] Cannot connect to ${ip}:`, e.message); return; }

  peerConnections.set(ip, ws);

  ws.on('open', ()=>{
    console.log(`[Peer] Connected: ${ip}`);
    ws.send(JSON.stringify({ type:'PEER_HELLO', operatorId:config.operatorId, callsign:config.callsign, maxSeq:getMaxSeq() }));
    const q=peerQueues.get(ip)||[]; peerQueues.delete(ip);
    q.forEach(m=>ws.send(m));
    broadcastPeerList();
  });

  ws.on('message', raw=>handlePeerMsg(ip, raw));

  ws.on('close', ()=>{
    console.log(`[Peer] Disconnected: ${ip}`);
    peerConnections.delete(ip);
    broadcastPeerList();
    if (discoveredPeers.has(ip)) setTimeout(()=>connectToPeer(ip,port), 8000);
  });

  ws.on('error', e=>{ console.warn(`[Peer] ${ip}:`, e.message); peerConnections.delete(ip); });
}

function handlePeerMsg(fromIP, raw) {
  let msg; try { msg=JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case 'PEER_HELLO': {
      // Send any QSOs they're missing
      if (typeof msg.maxSeq==='number') {
        const missing=dbAll(`SELECT * FROM qsos WHERE seq>? AND deleted=0 ORDER BY seq ASC`,[msg.maxSeq]);
        if (missing.length>0) { console.log(`[Peer] Sending ${missing.length} QSOs to ${fromIP}`); missing.forEach(q=>sendToPeer(fromIP,{type:'PEER_QSO',qso:q})); }
      }
      sendToPeer(fromIP, { type:'PEER_LIST', peers:getPeerInfoList() });
      // Send current operator states so the peer sees us in the Operator Status panel immediately
      getLocalOpStates().forEach(op=>sendToPeer(fromIP, op));
      // Update our discoveredPeers with the peer's operator callsign if provided
      if (msg.callsign && discoveredPeers.has(fromIP)) {
        discoveredPeers.get(fromIP).callsign = msg.callsign;
        broadcastPeerList();
      }
      break;
    }
    case 'PEER_QSO': {
      const q=msg.qso; if (!q?.callsign||!q?.id) return;
      if (dbGet(`SELECT 1 FROM qsos WHERE id=?`,[q.id])) return; // already have it
      if (!q.seq) q.seq=nextSeq(); else seqCounter=Math.max(seqCounter,q.seq);
      insertQSO(q);
      broadcastToBrowsers({type:'QSO_NEW',qso:q});
      if (!q.dupe_flag) postClublog(q).catch(()=>{});
      // Check DXCC achievements — peer QSOs count too
      if (!q.dupe_flag && q.band) {
        const achs = checkDXCCAchievements(q.band);
        achs.forEach(ach => {
          console.log(`[Achievement via peer] ${ach.achievementType}${ach.band ? ' on '+ach.band : ''}`);
          broadcastToBrowsers({ type:'ACHIEVEMENT', achievementType:ach.achievementType, band:ach.band||null, count:ach.count||null });
          broadcastToPeers({ type:'PEER_ACHIEVEMENT', achievementType:ach.achievementType, band:ach.band||null, count:ach.count||null });
        });
      }
      console.log(`[Peer] QSO from ${fromIP}: ${q.callsign} ${q.band} ${q.mode} op=${q.operator}`);
      break;
    }
    case 'PEER_QSO_EDIT':  updateQSO(msg.qso); broadcastToBrowsers({type:'QSO_EDIT',qso:msg.qso}); break;
    case 'PEER_QSO_DELETE': softDelete(msg.id); broadcastToBrowsers({type:'QSO_DELETE',id:msg.id}); break;
    case 'PEER_OP_STATE':
      broadcastToBrowsers({...msg, type:'OP_STATE'});
      // Update discovered peer's identity with the current OPON operator callsign
      // so the Network bar shows operator personal calls (e.g. NN2DX) not the
      // DXpedition call (VK0EK) or the generic config operatorId (OP2).
      if (msg.callsign && discoveredPeers.has(fromIP)) {
        const peer = discoveredPeers.get(fromIP);
        peer.callsign   = msg.callsign;
        peer.operatorId = msg.callsign;
        broadcastPeerList();
      }
      break;
    case 'PEER_QST':       broadcastToBrowsers({type:'QST',from:msg.from,text:msg.text,ts:msg.ts}); break;
    case 'PEER_ACHIEVEMENT': broadcastToBrowsers({type:'ACHIEVEMENT',achievementType:msg.achievementType,band:msg.band,count:msg.count}); break;
    case 'PEER_LIST':
      if (Array.isArray(msg.peers)) {
        const localIP=getLocalIP();
        msg.peers.forEach(p=>{ if(p.ip&&p.ip!==localIP&&!peerConnections.has(p.ip)) connectToPeer(p.ip,p.peerPort||PEER_PORT); });
      }
      break;
  }
}

function sendToPeer(ip, msg) {
  const ws=peerConnections.get(ip); const str=JSON.stringify(msg);
  if (ws&&ws.readyState===WebSocket.OPEN) ws.send(str);
  else { if(!peerQueues.has(ip)) peerQueues.set(ip,[]); const q=peerQueues.get(ip); q.push(str); if(q.length>500) q.splice(0,q.length-500); }
}

function broadcastToPeers(msg) {
  const str=JSON.stringify(msg);
  for (const [ip,ws] of peerConnections) {
    if (ws.readyState===WebSocket.OPEN) ws.send(str);
    else { if(!peerQueues.has(ip)) peerQueues.set(ip,[]); peerQueues.get(ip).push(str); }
  }
}

function getPeerInfoList() {
  const localIP=getLocalIP();
  const r=[{ip:localIP,operatorId:config.operatorId,callsign:config.callsign,peerPort:PEER_PORT,isSelf:true}];
  for(const[ip,info]of discoveredPeers) r.push({ip,operatorId:info.operatorId,callsign:info.callsign,peerPort:info.peerPort,isSelf:false});
  return r;
}

function broadcastPeerList() {
  const localIP=getLocalIP();
  const connectedIPs=new Set([...peerConnections.entries()].filter(([,ws])=>ws.readyState===WebSocket.OPEN).map(([ip])=>ip));
  const list=getPeerInfoList().map(p=>({...p,online:p.isSelf||connectedIPs.has(p.ip)}));
  broadcastToBrowsers({type:'PEER_LIST_UPDATE',peers:list});
}

// ── Inbound peer server ────────────────────────────────────────────────────────
function startPeerServer() {
  const peerWss=new WebSocket.Server({port:PEER_PORT});
  peerWss.on('connection',(ws,req)=>{
    const ip=(req.socket.remoteAddress||'').replace('::ffff:','');
    console.log(`[Peer] Inbound from ${ip}`);
    ws.send(JSON.stringify({type:'PEER_HELLO',operatorId:config.operatorId,callsign:config.callsign,maxSeq:getMaxSeq()}));
    // Proactively push our operator states and peer list so the new peer is
    // fully up-to-date immediately, without waiting for their PEER_HELLO response.
    setTimeout(()=>{
      try {
        ws.send(JSON.stringify({type:'PEER_LIST',peers:getPeerInfoList()}));
        getLocalOpStates().forEach(op=>{ try{ws.send(JSON.stringify(op));}catch{} });
      } catch {}
    }, 300);
    ws.on('message',raw=>handlePeerMsg(ip,raw));
    ws.on('close',()=>{ console.log(`[Peer] Inbound ${ip} closed`); if(peerConnections.get(ip)===ws) { peerConnections.delete(ip); broadcastPeerList(); } });
    ws.on('error',()=>{});
    if(!peerConnections.has(ip)||peerConnections.get(ip).readyState!==WebSocket.OPEN) { peerConnections.set(ip,ws); broadcastPeerList(); }
  });
  console.log(`[Peer] Server on :${PEER_PORT}`);
}

// ── Browser WebSocket ──────────────────────────────────────────────────────────
let _broadcastToBrowsers = null;
let _getLocalOpStates = null;
function broadcastToBrowsers(msg) { if(typeof _broadcastToBrowsers==='function') _broadcastToBrowsers(msg); }
function getLocalOpStates() { return typeof _getLocalOpStates==='function' ? _getLocalOpStates() : []; }

function startBrowserWS() {
  const wss=new WebSocket.Server({port:WS_PORT});
  const stations=new Map();
  let masterSessionId=null;

  wss.on('connection', ws=>{
    let opId=null;

    ws.on('message', raw=>{
      let msg; try{msg=JSON.parse(raw);}catch{return;}
      switch(msg.type) {

        case 'HANDSHAKE': {
          opId=msg.sessionId||msg.operatorId||'OP?';
          const prevAlive=masterSessionId&&stations.has(masterSessionId);
          const isMasterTab=msg.isMaster&&!prevAlive;
          if(isMasterTab) masterSessionId=opId;
          stations.set(opId,{ws,callsign:msg.callsign||msg.operatorId||opId,operatorId:msg.operatorId||opId,isMaster:isMasterTab});
          console.log(`[Browser] ${opId} (${msg.callsign}) joined`);
          ws.send(JSON.stringify({
            type:'FULL_SYNC', qsos:getAll(), stats:getStats(), usbStatus:getUSBStatus(),
            operators:config.operators||[], sessionId:opId, operatorId:config.operatorId,
            callsign:config.callsign, youAreMaster:isMasterTab, peers:getPeerInfoList(), version:VERSION,
          }));
          bcastAll({type:'STATION_LIST',stations:stationList(),masterId:config.operatorId,operators:config.operators||[]});
          broadcastPeerList();
          // Push this operator's state to all peers so they see us immediately
          broadcastToPeers({type:'PEER_OP_STATE',stationId:opId,operatorId:msg.operatorId||opId,
            callsign:msg.callsign||msg.operatorId||opId,sourceStation:config.operatorId});
          // Push current rig state to this new browser immediately
          if (_fbOnline && _fbLastFreq) {
            ws.send(JSON.stringify({
              type:'CAT_STATE', online:true,
              freq:_fbLastFreq, rxFreq:_fbLastRx||_fbLastFreq,
              band:freqToBandServer(_fbLastFreq), mode:_fbLastMode||'SSB', split:false
            }));
          }
          break;
        }

        case 'LOG_QSO': {
          const q=msg.qso; if(!q?.callsign) return;
          q.id=q.id||uuidv4(); q.seq=nextSeq();
          q.source_station=config.operatorId;
          q.operator=q.operator||msg.callsign||opId||config.operatorId;
          q.dupe_flag=isDupe(q.callsign,q.band,q.mode)?1:0;
          insertQSO(q);
          ws.send(JSON.stringify({type:'QSO_ACK',id:q.id,seq:q.seq,dupe:q.dupe_flag}));
          bcastAll({type:'QSO_NEW',qso:q});
          broadcastToPeers({type:'PEER_QSO',qso:q});
          if(!q.dupe_flag) postClublog(q).catch(()=>{});
          // Check DXCC achievements on this band
          if (!q.dupe_flag && q.band) {
            const achs = checkDXCCAchievements(q.band);
            achs.forEach(ach => {
              console.log(`[Achievement] ${ach.achievementType}${ach.band ? ' on ' + ach.band : ''}`);
              bcastAll({ type:'ACHIEVEMENT', achievementType:ach.achievementType, band:ach.band||null, count:ach.count||null });
              broadcastToPeers({ type:'PEER_ACHIEVEMENT', achievementType:ach.achievementType, band:ach.band||null, count:ach.count||null });
            });
          }
          console.log(`[QSO] #${q.seq} ${q.callsign} ${q.band} ${q.mode} op=${q.operator} src=${q.source_station}`);
          break;
        }

        case 'EDIT_QSO':
          updateQSO(msg.qso); bcastAll({type:'QSO_EDIT',qso:msg.qso});
          broadcastToPeers({type:'PEER_QSO_EDIT',qso:msg.qso}); break;

        case 'DELETE_QSO':
          softDelete(msg.id); bcastAll({type:'QSO_DELETE',id:msg.id});
          broadcastToPeers({type:'PEER_QSO_DELETE',id:msg.id}); break;

        case 'OP_STATE':
          if(stations.has(opId)) {
            const st=stations.get(opId);
            if(msg.callsign) st.callsign=msg.callsign;
            if(msg.txFreq)   st.txFreq=msg.txFreq;
            if(msg.rxFreq)   st.rxFreq=msg.rxFreq;
            if(msg.mode)     st.mode=msg.mode;
          }
          bcastAll({...msg,stationId:opId,operatorId:stations.get(opId)?.operatorId||opId});
          broadcastToPeers({...msg,type:'PEER_OP_STATE',stationId:opId,sourceStation:config.operatorId}); break;

        case 'OPON_CHANGE':
          if(stations.has(opId)) stations.get(opId).callsign=msg.callsign;
          if(msg.callsign&&!(config.operators||[]).includes(msg.callsign)) (config.operators=config.operators||[]).push(msg.callsign);
          bcastAll({type:'OPON_CHANGED',stationId:opId,callsign:msg.callsign,operators:config.operators||[]}); break;

        case 'QST':
          if(msg.text?.trim()) {
            const qst={type:'PEER_QST',from:msg.from||opId,text:msg.text.trim(),ts:msg.ts||new Date().toISOString()};
            broadcastToPeers(qst);
            bcastExcept(opId,{type:'QST',from:qst.from,text:qst.text,ts:qst.ts});
            console.log(`[QST] ${qst.from}: ${qst.text}`);
          }
          break;

        case 'PING':
          ws.send(JSON.stringify({type:'PONG',stats:getStats(),usbStatus:getUSBStatus(),operators:config.operators||[],peers:getPeerInfoList()})); break;

        case 'SET_FREQ': {
          const hz = Math.round(parseFloat(msg.freq) * 1e6);
          if (isNaN(hz) || hz < 1000000) { console.warn('[CAT] SET_FREQ bad hz:', msg.freq); break; }
          // Always try FlexBridge REST — harmless if not running
          const fbPort2 = getActiveBridgePort();
          const cmd2 = `FA${String(hz).padStart(11, '0')};`;
          const body2 = JSON.stringify({ command: cmd2 });
          console.log(`[CAT] SET_FREQ → ${(hz/1e6).toFixed(3)} MHz  cmd=${cmd2}  port=${fbPort2}  poll=${!!_fbPollTimer}`);
          const req2 = http.request({
            host:'127.0.0.1', port:fbPort2, path:'/cat/command',
            method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body2)}
          }, res2 => {
            let rb=''; res2.on('data',d=>rb+=d);
            res2.on('end',()=>console.log(`[CAT] SET_FREQ response: ${res2.statusCode} ${rb.slice(0,80)}`));
          });
          req2.on('error', e => console.warn('[CAT SET_FREQ error]', e.message));
          req2.setTimeout(2000, ()=>{ console.warn('[CAT SET_FREQ timeout]'); req2.destroy(); });
          req2.write(body2); req2.end();
          break;
        }

        case 'SET_MODE': {
          if (!msg.mode) break;
          const fbPort3 = getActiveBridgePort();
          const ts2k = { SSB:'2', CW:'3', FT8:'9', DIGU:'9', AM:'5', FM:'4' }[msg.mode.toUpperCase()] || '2';
          const cmd3 = `MD${ts2k};`;
          const body3 = JSON.stringify({ command: cmd3 });
          console.log(`[CAT] SET_MODE → ${msg.mode}  cmd=${cmd3}  port=${fbPort3}`);
          const req3 = http.request({
            host:'127.0.0.1', port:fbPort3, path:'/cat/command',
            method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body3)}
          }, res3 => {
            let rb=''; res3.on('data',d=>rb+=d);
            res3.on('end',()=>console.log(`[CAT] SET_MODE response: ${res3.statusCode} ${rb.slice(0,80)}`));
          });
          req3.on('error', e => console.warn('[CAT SET_MODE error]', e.message));
          req3.setTimeout(2000, ()=>{ console.warn('[CAT SET_MODE timeout]'); req3.destroy(); });
          req3.write(body3); req3.end();
          // Auto-launch WSJT-X when switching to FT8
          if (msg.mode === 'FT8' && config.wsjt?.autoLaunch && config.wsjt?.binaryPath) {
            if (!global._wsjtProc || global._wsjtProc.killed) {
              const wsjtPath = config.wsjt.binaryPath;
              if (fs.existsSync(wsjtPath)) {
                const {spawn}=require('child_process');
                const proc=spawn(wsjtPath,[],{detached:false,stdio:'ignore'});
                proc.on('exit',code=>{console.log(`[WSJT-X] exited (${code})`);global._wsjtProc=null;});
                global._wsjtProc=proc;
                console.log(`[WSJT-X] auto-launched PID ${proc.pid}`);
              }
            }
          }
          break;
        }

        case 'CWX_SEND':
          if (msg.text) sendCWX(msg.text);
          break;

        case 'CWX_CLEAR':
          clearCWX();
          break;

        case 'CWX_SPEED': {
          const spd = parseInt(msg.wpm) || 25;
          if (!config.cw) config.cw = {};
          config.cw.speed = spd;
          sendCWXSpeed(spd);
          break;
        }
      }
    });

    ws.on('close',()=>{
      if(opId){stations.delete(opId);if(opId===masterSessionId){masterSessionId=null;console.log('[Browser] Master tab closed');}
      console.log(`[Browser] ${opId} left`);bcastAll({type:'STATION_LIST',stations:stationList(),masterId:config.operatorId,operators:config.operators||[]});}
    });
    ws.on('error',()=>{if(opId)stations.delete(opId);});
  });

  function stationList() {
    return [...stations.entries()].map(([id,info])=>({id,callsign:info.callsign||id,operatorId:info.operatorId||id,isMaster:info.isMaster||false,online:info.ws.readyState===WebSocket.OPEN}));
  }
  function bcastAll(msg) { const d=JSON.stringify(msg); for(const[,i]of stations) if(i.ws.readyState===WebSocket.OPEN) i.ws.send(d); }
  function bcastExcept(xId,msg) { const d=JSON.stringify(msg); for(const[id,i]of stations) if(id!==xId&&i.ws.readyState===WebSocket.OPEN) i.ws.send(d); }

  _broadcastToBrowsers = bcastAll;
  _getLocalOpStates = () => [...stations.entries()].map(([id,info])=>({
    type:'PEER_OP_STATE', stationId:id, operatorId:info.operatorId||id,
    callsign:info.callsign||id, sourceStation:config.operatorId,
    txFreq:info.txFreq||null, rxFreq:info.rxFreq||null, mode:info.mode||null,
  }));
}

// ── HTTP ───────────────────────────────────────────────────────────────────────
function startHTTP() {
  const server=http.createServer((req,res)=>{
    const {pathname}=new URL(req.url,'http://localhost');

    // First-run redirect
    if (pathname==='/'&&!isConfigured()) { res.writeHead(302,{Location:'/setup.html'}); return res.end(); }

    if (pathname==='/api/stats') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(getStats(),null,2)); }
    if (pathname==='/api/qsos')  { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(getAll())); }

    if (pathname==='/api/config'&&req.method==='GET') {
      const localIP=getLocalIP();
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({
        version:VERSION, callsign:config.callsign, operatorId:config.operatorId, role:'peer',
        wsPort:WS_PORT, peerPort:PEER_PORT, httpPort:HTTP_PORT, localIP,
        configured:isConfigured(), contest:config.contest, operators:config.operators||[],
        spots:config.spots||[], clublog:{enabled:!!(config.clublog?.enabled)},
        cat:{enabled:!!(config.cat?.enabled)}, usbStatus:getUSBStatus(), peers:getPeerInfoList(),
        cw:config.cw||{}, wsjt:{enabled:!!(config.wsjt?.enabled)},
      }));
    }

    if (pathname==='/api/config-full') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(config)); }

    if (pathname==='/api/setup'&&req.method==='POST') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const data=JSON.parse(body);
          if (!data.callsign||!data.operatorId) throw new Error('callsign and operatorId required');
          config.callsign=data.callsign.trim().toUpperCase();
          config.operatorId=data.operatorId.trim().toUpperCase();
          config._configured=true;
          if(data.operators) config.operators=data.operators;
          fs.writeFileSync(CFG_PATH,JSON.stringify(config,null,2));
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,callsign:config.callsign,operatorId:config.operatorId}));
          console.log(`[Setup] ${config.callsign} / ${config.operatorId}`);
        } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
      });
      return;
    }

    if (pathname==='/api/settings'&&req.method==='POST') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const p=JSON.parse(body);
          if(p.callsign)   config.callsign  =p.callsign.trim().toUpperCase();
          if(p.operatorId) config.operatorId=p.operatorId.trim().toUpperCase();
          if(p.operators)  config.operators =p.operators;
          if(p.contest)    config.contest   ={...config.contest,...p.contest};
          if(p.clublog)    config.clublog   ={...config.clublog,...p.clublog};
          if(p.cat)        config.cat       ={...config.cat,...p.cat};
          if(p.backup)     config.backup    ={...config.backup,...p.backup};
          if(p.network)    config.network   ={...config.network,...p.network};
          if(p.wsjt)       config.wsjt      ={...config.wsjt,...p.wsjt};
          if(p.cw)         config.cw        ={...config.cw,...p.cw};
          if(p.peers)      config.peers     =p.peers;
          config._configured=true;
          fs.writeFileSync(CFG_PATH,JSON.stringify(config,null,2));
          // Restart cat-bridge if CAT settings changed
          if (p.cat) { setTimeout(autostartCatBridge, 500); setTimeout(()=>startFlexBridgePoll(true), 600); }
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
      });
      return;
    }

    if (pathname==='/api/usb-status') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(getUSBStatus())); }
    if (pathname==='/api/usb-backup-now'&&req.method==='POST') { backupToUSB(); backupADIFToUSB(); res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,usbStatus:getUSBStatus()})); }

    if (pathname==='/api/reset'&&req.method==='POST') {
      try {
        // 1. Wipe all QSOs from the database
        db.run(`DELETE FROM qsos`);
        saveDb();
        // 2. Reset in-memory counters
        seqCounter = 0;
        firedAchievements.clear();
        // 3. Broadcast RESET to all connected browsers so they wipe localStorage
        broadcastToBrowsers({ type:'FULL_RESET' });
        console.log('[Reset] Log wiped by operator via settings page');
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,message:'Log cleared. All clients notified.'}));
      } catch(e) {
        res.writeHead(500,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }

    // ── FlexBridge daemon control ──────────────────────────────────────────
    if (pathname==='/api/flexbridge/start'&&req.method==='POST') {
      try {
        const {spawn, execSync}=require('child_process'),fs2=require('fs');
        const fb=config.cat?.flexbridge||{};
        const candidates=[
          path.join(__dirname,'flexbridge','src','flexbridge.py'),
          path.join(__dirname,'..','flexbridge','src','flexbridge.py'),
          path.join(process.env.HOME||'','.local','flexbridge','src','flexbridge.py'),
        ];
        const fbScript=candidates.find(p=>fs2.existsSync(p));
        if (!fbScript) {
          res.writeHead(404,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok:false,error:'FlexBridge not found. Run install-flexbridge.sh from the Team Leader folder first.'}));
        }
        // Kill existing process and wait before spawning
        if (global._flexbridgeProc) {
          try { global._flexbridgeProc.kill('SIGKILL'); } catch {}
          global._flexbridgeProc = null;
        }
        // Respond immediately
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true,starting:true}));
        // Small delay then spawn — NO pkill (it races with the new process)
        setTimeout(() => {
          try {
            // Use login shell to find python3 — guarantees same result as terminal
            // This works with pyenv, Homebrew, system Python, and venvs
            const {execSync: execSyncPy} = require('child_process');
            const shellPath = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
            let python3 = '';
            try {
              python3 = execSyncPy(`${shellPath} -l -c "which python3"`, {
                timeout: 3000, encoding: 'utf8'
              }).trim();
            } catch(e) { console.warn('[FlexBridge] which python3 failed:', e.message); }

            // Fallback: check common paths directly
            if (!python3) {
              const fs3 = require('fs');
              const home = process.env.HOME || require('os').homedir();
              for (const p of [
                path.join(home, '.pyenv', 'shims', 'python3'),
                '/opt/homebrew/bin/python3',
                '/usr/local/bin/python3',
                '/usr/bin/python3',
              ]) {
                if (fs3.existsSync(p)) { python3 = p; break; }
              }
            }

            if (!python3) python3 = 'python3'; // last resort
            console.log(`[FlexBridge] Python3: ${python3}`);
            console.log(`[FlexBridge] Script:  ${fbScript}`);

            const fbArgs = [fbScript];
            if (fb.radioIp) fbArgs.push('--radio', fb.radioIp);
            if (fb.catTcpPort) fbArgs.push('--cat-port', String(fb.catTcpPort));
            if (fb.daxChannels && fb.daxChannels.length)
              fbArgs.push('--dax-channels', fb.daxChannels.join(','));

            // Build PATH with all common python locations prepended
            const home2 = process.env.HOME || require('os').homedir();
            const augPath = [
              path.join(home2, '.pyenv', 'shims'),
              path.dirname(python3),
              '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
              process.env.PATH || '',
            ].filter(Boolean).join(':');

            const proc = spawn(python3, fbArgs, {
              cwd: path.dirname(fbScript),
              detached: false,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PATH: augPath },
            });
            proc.stdout.on('data', d => console.log('[FlexBridge]', d.toString().trimEnd()));
            proc.stderr.on('data', d => console.log('[FlexBridge] ERR', d.toString().trimEnd()));
            proc.on('error', e => console.error('[FlexBridge] SPAWN ERROR:', e.message));
            proc.on('exit', (code, sig) => {
              console.log(`[FlexBridge] exited code=${code} signal=${sig}`);
              global._flexbridgeProc = null;
            });
            global._flexbridgeProc = proc;
            console.log(`[FlexBridge] started PID ${proc.pid}`);
            setTimeout(() => startFlexBridgePoll(true), 2000);
          } catch(e) { console.error('[FlexBridge] spawn failed:', e.message, e.stack); }
        }, 400);
        return; // response already sent above
      } catch(e){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,error:e.message}));}
    }

    // ── Icom bridge API ────────────────────────────────────────────────────
    if (pathname==='/api/icom/start'&&req.method==='POST') {
      try {
        if (!config.cat) config.cat = {};
        if (!config.cat.icom) config.cat.icom = {};
        config.cat.icom.enabled = true;
        config.cat.rigType = 'icom';
        fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2));
        startIcomBridge();
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true, port: config.cat.icom.statusPort || 7377}));
      } catch(e) {
        res.writeHead(500,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:false, error:e.message}));
      }
    }

    if (pathname==='/api/icom/stop'&&req.method==='POST') {
      stopIcomBridge();
      stopFlexBridgePoll();
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true}));
    }

    if (pathname==='/api/icom/status') {
      const running = !!(_icomBridge && _icomBridge.connected);
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({running, connected: running, radioIp: config.cat?.icom?.radioIp}));
    }

    if (pathname==='/api/flexbridge/stop'&&req.method==='POST') {
      if (global._flexbridgeProc){try{global._flexbridgeProc.kill('SIGTERM');}catch{}global._flexbridgeProc=null;}
      stopFlexBridgePoll();
      res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true}));
    }

    if (pathname==='/api/flexbridge/status') {
      const running=!!(global._flexbridgeProc&&!global._flexbridgeProc.killed);
      res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({running,pid:running?global._flexbridgeProc.pid:null}));
    }

    if (pathname==='/api/flexbridge/test'&&req.method==='POST') {
      // Direct synchronous test spawn - bypasses all async complexity
      try {
        const {spawnSync, execSync: eSync} = require('child_process'), fs4=require('fs'), os4=require('os');
        const fbPaths = [
          path.join(__dirname,'flexbridge','src','flexbridge.py'),
          path.join(__dirname,'..','flexbridge','src','flexbridge.py'),
        ];
        const fbScript4 = fbPaths.find(p=>fs4.existsSync(p));
        if (!fbScript4) return res.end(JSON.stringify({ok:false,error:'flexbridge.py not found'}));

        // Find python3 via login shell
        let py3 = '';
        const sh = process.platform==='darwin' ? '/bin/zsh' : '/bin/bash';
        try { py3 = eSync(`${sh} -l -c "which python3"`,{timeout:3000,encoding:'utf8'}).trim(); } catch(e) {}
        if (!py3) {
          const home4 = process.env.HOME||os4.homedir();
          for (const p of [path.join(home4,'.pyenv','shims','python3'),'/opt/homebrew/bin/python3','/usr/local/bin/python3','/usr/bin/python3']) {
            if (fs4.existsSync(p)) { py3=p; break; }
          }
        }
        if (!py3) py3 = 'python3';

        console.log(`[FlexBridge TEST] python3=${py3} script=${fbScript4}`);

        // Kill existing
        if (global._flexbridgeProc) { try{global._flexbridgeProc.kill('SIGKILL');}catch{} global._flexbridgeProc=null; }

        const home5 = process.env.HOME||os4.homedir();
        const augPath = [path.join(home5,'.pyenv','shims'),path.dirname(py3),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin',process.env.PATH||''].filter(Boolean).join(':');

        const fb4 = config.cat?.flexbridge||{};
        const args4 = [fbScript4];
        if (fb4.radioIp) args4.push('--radio',fb4.radioIp);
        if (fb4.catTcpPort) args4.push('--cat-port',String(fb4.catTcpPort));
        if (fb4.daxChannels&&fb4.daxChannels.length) args4.push('--dax-channels',fb4.daxChannels.join(','));

        const proc4 = require('child_process').spawn(py3, args4, {
          cwd: path.dirname(fbScript4), detached:false,
          stdio:['ignore','pipe','pipe'],
          env:{...process.env, PATH:augPath},
        });
        proc4.stdout.on('data',d=>console.log('[FlexBridge]',d.toString().trimEnd()));
        proc4.stderr.on('data',d=>console.log('[FlexBridge] ERR',d.toString().trimEnd()));
        proc4.on('error',e=>{ console.error('[FlexBridge] SPAWN ERROR:',e.message); global._flexbridgeProc=null; });
        proc4.on('exit',(c,sg)=>{ console.log(`[FlexBridge] exited code=${c} signal=${sg}`); global._flexbridgeProc=null; });
        global._flexbridgeProc = proc4;
        console.log(`[FlexBridge TEST] started PID ${proc4.pid}`);
        setTimeout(()=>startFlexBridgePoll(true), 2500);
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,pid:proc4.pid,python3:py3,script:fbScript4}));
      } catch(e) {
        console.error('[FlexBridge TEST] error:',e.message);
        res.writeHead(500,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:false,error:e.message}));
      }
    }

    if (pathname==='/api/flexbridge/diagnose') {
      const fbPort = parseInt(config.cat?.flexbridge?.statusPort) || 7376;
      const procRunning = !!(global._flexbridgeProc && !global._flexbridgeProc.killed);
      const diag = { procRunning, pid: procRunning ? global._flexbridgeProc?.pid : null, port: fbPort, steps: [] };
      // Test: can we TCP connect to FlexBridge port?
      const netTest = new Promise(resolve => {
        const sock = new (require('net').Socket)();
        sock.setTimeout(2000);
        sock.connect(fbPort, '127.0.0.1', () => { sock.destroy(); resolve({tcp: true}); });
        sock.on('error', e => resolve({tcp: false, tcpError: e.message}));
        sock.on('timeout', () => { sock.destroy(); resolve({tcp: false, tcpError: 'timeout'}); });
      });
      // Test: can we HTTP GET /status?
      const httpTest = new Promise(resolve => {
        const req = http.get({host:'127.0.0.1',port:fbPort,path:'/status',timeout:2000}, res2 => {
          let buf=''; res2.on('data',d=>buf+=d);
          res2.on('end',()=>resolve({http:true,statusCode:res2.statusCode,body:buf.slice(0,200)}));
        });
        req.on('error', e => resolve({http:false,httpError:e.message}));
        req.on('timeout', () => {req.destroy(); resolve({http:false,httpError:'timeout'});});
      });
      Promise.all([netTest, httpTest]).then(([tcp, httpR]) => {
        diag.tcp = tcp;
        diag.http = httpR;
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(diag,null,2));
      });
      return;
    }

    // ── FlexBridge REST proxy ─────────────────────────────────────────────────
    // All /api/fb/* requests are proxied to FlexBridge's REST API on port 7376.
    if (pathname.startsWith('/api/fb/')) {
      const fbPath = pathname.replace('/api/fb', '');
      const fbPort = getActiveBridgePort();
      let reqBody = '';
      req.on('data', d => reqBody += d);
      req.on('end', () => {
        const isGet = req.method === 'GET';
        const headers = isGet
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) };
        const fbReq = http.request({
          host: '127.0.0.1', port: fbPort, path: fbPath,
          method: req.method, headers
        }, fbRes => {
          let buf = '';
          fbRes.on('data', d => buf += d);
          fbRes.on('end', () => {
            res.writeHead(fbRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(buf);
          });
        });
        fbReq.on('error', e => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'FlexBridge not reachable: ' + e.message }));
        });
        fbReq.setTimeout(5000, () => {
          fbReq.destroy();
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'FlexBridge timeout' }));
        });
        if (!isGet) fbReq.write(reqBody);
        fbReq.end();
      });
      return;
    }

    // ── CWX endpoints ────────────────────────────────────────────────────────
    if (pathname==='/api/cwx/send'&&req.method==='POST') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const p=JSON.parse(body);
          if (!p.text) { res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'No text'})); }
          sendCWX(p.text, p.wpm);
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
        } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }

    if (pathname==='/api/cwx/clear'&&req.method==='POST') {
      clearCWX();
      res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true}));
    }

    // ── WSJT-X endpoints ─────────────────────────────────────────────────────
    if (pathname==='/api/wsjt/launch'&&req.method==='POST') {
      let body=''; req.on('data',d=>body+=d);
      req.on('end',()=>{
        try {
          const wsjtPath = config.wsjt?.binaryPath || '';
          if (!wsjtPath || !fs.existsSync(wsjtPath)) {
            res.writeHead(404,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({ok:false,error:'WSJT-X binary not found — set path in Settings'}));
          }
          if (global._wsjtProc && !global._wsjtProc.killed) {
            res.writeHead(200,{'Content-Type':'application/json'});
            return res.end(JSON.stringify({ok:true,already:true,pid:global._wsjtProc.pid}));
          }
          const {spawn}=require('child_process');
          const proc=spawn(wsjtPath,[],{detached:false,stdio:'ignore'});
          proc.on('exit',code=>{ console.log(`[WSJT-X] exited (${code})`); global._wsjtProc=null; });
          global._wsjtProc=proc;
          console.log(`[WSJT-X] launched PID ${proc.pid}`);
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,pid:proc.pid}));
        } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
      }); return;
    }

    if (pathname==='/api/wsjt/stop'&&req.method==='POST') {
      if (global._wsjtProc) { try { global._wsjtProc.kill(); } catch {} global._wsjtProc=null; }
      res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true}));
    }

    if (pathname==='/api/wsjt/status') {
      const running=!!(global._wsjtProc&&!global._wsjtProc.killed);
      res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({running,pid:running?global._wsjtProc.pid:null}));
    }

    if (pathname==='/api/peers') {
      const localIP=getLocalIP();
      const connectedIPs=new Set([...peerConnections.entries()].filter(([,ws])=>ws.readyState===WebSocket.OPEN).map(([ip])=>ip));
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({
        self:{ip:localIP,operatorId:config.operatorId,callsign:config.callsign},
        discovered:[...discoveredPeers.entries()].map(([ip,p])=>({ip,...p,connected:connectedIPs.has(ip)})),
      }));
    }

    if (pathname==='/api/cat-ports') {
      const {execSync}=require('child_process'); let ports=[];
      try { const cmd=process.platform==='darwin'?'ls /dev/cu.usb* /dev/cu.USB* 2>/dev/null||true':'ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null||true'; ports=execSync(cmd).toString().trim().split('\n').filter(Boolean); } catch {}
      res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ports}));
    }

    if (pathname==='/api/cat-command') {
      const cat=config.cat||{}; const cmd=cat.rigModel&&cat.serialPort?`rigctld -m ${cat.rigModel} -r ${cat.serialPort} -s ${cat.baudRate||19200} -T ${cat.rigctldHost||'127.0.0.1'} -t ${cat.rigctldPort||4532}`:null;
      res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({cmd,configured:!!(cat.rigModel&&cat.serialPort)}));
    }

    // Returns server Unix timestamp in ms — used by the browser to measure
    // clock offset and check NTP sync quality
    if (pathname==='/api/time') {
      const t = Date.now();
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({serverTime:t,iso:new Date(t).toISOString()}));
    }

    if (pathname==='/api/solar-refresh'&&req.method==='POST') {
      solarCache={data:null,ts:0}; res.writeHead(200,{'Content-Type':'application/json'});
      fetchSolarData().then(d=>{solarCache={data:d,ts:Date.now()};res.end(JSON.stringify(d));}).catch(e=>res.end(JSON.stringify({error:e.message}))); return;
    }

    if (pathname==='/api/solar') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      if(solarCache.data&&Date.now()-solarCache.ts<60*60*1000) return res.end(JSON.stringify(solarCache.data));
      fetchSolarData().then(d=>{solarCache={data:d,ts:Date.now()};res.end(JSON.stringify(d));}).catch(()=>res.end(JSON.stringify(solarCache.data||{sfi:null,a:null,k:null,error:true}))); return;
    }

    if (pathname==='/api/scp') {
      if(!fs.existsSync(SCP_FILE)){res.writeHead(404);return res.end('{}');}
      res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'public, max-age=86400'}); return fs.createReadStream(SCP_FILE).pipe(res);
    }
    if (pathname==='/api/scp-status') { res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({available:fs.existsSync(SCP_FILE),callsigns:scpLines})); }

    if (pathname==='/api/export.adi') {
      res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':`attachment; filename="${config.callsign}_export.adi"`});
      return res.end(buildADIF());
    }

    const filePath=path.join(__dirname,'public',pathname==='/'?'index.html':pathname);
    const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(filePath)]||'text/plain';
    fs.readFile(filePath,(err,data)=>{
      if(err){fs.readFile(path.join(__dirname,'public','index.html'),(e2,d2)=>{if(e2){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':'text/html'});res.end(d2);});return;}
      res.writeHead(200,{'Content-Type':mime});res.end(data);
    });
  });

  server.listen(HTTP_PORT,'0.0.0.0',()=>{
    const localIP=getLocalIP();
    console.log('');
    console.log('  ████████╗███████╗ █████╗ ███╗   ███╗');
    console.log('     ██╔══╝██╔════╝██╔══██╗████╗ ████║');
    console.log('     ██║   █████╗  ███████║██╔████╔██║');
    console.log('     ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║');
    console.log('     ██║   ███████╗██║  ██║██║ ╚═╝ ██║');
    console.log('     ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝');
    console.log('');
    console.log('  ██╗     ███████╗ █████╗ ██████╗ ███████╗██████╗ ');
    console.log('  ██║     ██╔════╝██╔══██╗██╔══██╗██╔════╝██╔══██╗');
    console.log('  ██║     █████╗  ███████║██║  ██║█████╗  ██████╔╝');
    console.log('  ██║     ██╔══╝  ██╔══██║██║  ██║██╔══╝  ██╔══██╗');
    console.log('  ███████╗███████╗██║  ██║██████╔╝███████╗██║  ██║');
    console.log('  ╚══════╝╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝');
    console.log('                                         by WW2DX');
    console.log('');
    console.log(`  Version  : v${VERSION}`);
    console.log(`  Topology : PEER MESH — every station is equal`);
    console.log(`  Callsign : ${config.callsign}`);
    console.log(`  Station  : ${config.operatorId}`);
    console.log(`  IP       : ${localIP}`);
    console.log(`  Logger   : http://localhost:${HTTP_PORT}`);
    console.log(`  Others   : http://${localIP}:${HTTP_PORT}`);
    console.log(`  mDNS     : auto-discovering peers on LAN`);
    if(!isConfigured()) console.log('\n  *** NOT CONFIGURED — open browser to run setup ***\n');
    const usb=getUSBStatus();
    console.log(usb.hasUSB?`  USB      : ${usb.backupPath}`:`  USB      : no drive detected`);
    console.log(`  Clublog  : ${config.clublog?.enabled?'ENABLED (own QSOs only)':'disabled'}`);
    console.log('');
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  const SQL=await initSqlJs();
  if(fs.existsSync(DB_FILE)){db=new SQL.Database(fs.readFileSync(DB_FILE));console.log('[DB] Loaded');}
  else {
    const usbPath=getUSBBackupPath(); const usbDb=usbPath?path.join(usbPath,'teamleader.db'):null;
    if(usbDb&&fs.existsSync(usbDb)){console.log(`[DB] Restoring from USB`);const d=fs.readFileSync(usbDb);fs.writeFileSync(DB_FILE,d);db=new SQL.Database(d);}
    else{db=new SQL.Database();console.log('[DB] Created new database');}
  }
  initSchema();
  seqCounter=getMaxSeq();
  const qsoCount=getAll().length;
  console.log(`[DB] Seq #${seqCounter} — ${qsoCount} QSOs`);
  if(qsoCount>0){backupToUSB();backupADIFToUSB();}
  setInterval(backupADIFToUSB, ADIF_INTERVAL_MS);
  scheduleSolar();
  scheduleSCP();
  startPeerServer();
  startMDNS();
  startBrowserWS();
  startHTTP();
  autostartCatBridge();
  startFlexBridgePoll();
  // Start Icom bridge if configured
  if (config.cat?.rigType === 'icom' || config.cat?.icom?.enabled) {
    startIcomBridge();
  }
  if (config.wsjt?.enabled) startWsjtListener();
}

// Auto-spawn cat-bridge.js if CAT is enabled in config
function autostartCatBridge() {
  const cat = config.cat || {};
  if (!cat.enabled) return;
  const bridgePath = path.join(__dirname, 'cat-bridge.js');
  if (!fs.existsSync(bridgePath)) return;
  const {spawn} = require('child_process');
  // Kill any existing cat-bridge process
  if (global._catBridgeProc) { try { global._catBridgeProc.kill(); } catch {} }
  const proc = spawn(process.execPath, [bridgePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout.on('data', d => process.stdout.write('[CAT] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[CAT] ' + d));
  proc.on('exit', code => {
    console.log(`[CAT] cat-bridge exited (${code}) — restarting in 5s`);
    global._catBridgeProc = null;
    if (code !== null) setTimeout(autostartCatBridge, 5000);
  });
  global._catBridgeProc = proc;
  const isFlexMode = cat.rigType === 'flex' || !!(cat.flexbridge?.enabled);
  console.log(`[CAT] cat-bridge started (${isFlexMode ? 'FlexBridge mode' : 'rigctld mode'}) PID ${proc.pid}`);
}

// ── Clean shutdown — kill spawned children so they don't orphan and hold ports ──
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[Server] ${signal || 'shutdown'} — stopping child processes`);
  const kids = [
    ['Icom',       global._icomBridgeProc],
    ['FlexBridge', global._flexbridgeProc],
    ['cat-bridge', global._catBridgeProc],
    ['WSJT-X',     global._wsjtProc],
  ];
  for (const [name, proc] of kids) {
    if (!proc || proc.killed) continue;
    try {
      proc.kill('SIGTERM');
      console.log(`[Server] sent SIGTERM to ${name} pid=${proc.pid}`);
    } catch (e) {
      console.warn(`[Server] kill ${name} failed:`, e.message);
    }
  }
  // Hard-kill any survivors after a brief grace period, then exit
  setTimeout(() => {
    for (const [name, proc] of kids) {
      if (!proc || proc.killed) continue;
      try { proc.kill('SIGKILL'); console.log(`[Server] SIGKILL ${name}`); } catch {}
    }
    process.exit(0);
  }, 800).unref();
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));
// 'exit' fires on uncaught exit too — best-effort sync kill of children
process.on('exit', () => {
  for (const proc of [global._flexbridgeProc, global._catBridgeProc, global._wsjtProc]) {
    if (proc && !proc.killed) { try { proc.kill('SIGKILL'); } catch {} }
  }
});

boot().catch(err=>{console.error('Fatal:',err);process.exit(1);});
