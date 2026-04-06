#!/usr/bin/env node
// Team Leader — FlexBridge Spawn Diagnostic
// Run: node diagnose-flexbridge.js
// This replicates exactly what the Team Leader server does when starting FlexBridge

const { spawn, execSync } = require('child_process');
const net  = require('net');
const http = require('http');
const path = require('path');
const fs   = require('fs');

const PORT = 7376;

function log(msg) { process.stdout.write('[Diag] ' + msg + '\n'); }

async function checkPort(port, timeout = 2000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function checkHttp(port, timeout = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: buf.slice(0, 200) }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

async function main() {
  log('=== FlexBridge Spawn Diagnostic ===\n');

  // 1. Find FlexBridge script
  const candidates = [
    path.join(__dirname, 'flexbridge', 'src', 'flexbridge.py'),
    path.join(__dirname, '..', 'flexbridge', 'src', 'flexbridge.py'),
  ];
  const fbScript = candidates.find(p => fs.existsSync(p));
  if (!fbScript) { log('ERROR: flexbridge.py not found in: ' + candidates.join(', ')); process.exit(1); }
  log('FlexBridge script: ' + fbScript);

  // 2. Find Python3
  log('\nSearching for python3...');
  const pythonCandidates = [
    (process.env.PYENV_ROOT || '') + '/shims/python3',
    '/opt/homebrew/bin/python3',
    '/opt/homebrew/opt/python3/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];

  let python3 = null;
  for (const p of pythonCandidates) {
    if (fs.existsSync(p)) {
      log('  Found: ' + p);
      python3 = p;
      break;
    } else {
      log('  Not found: ' + p);
    }
  }

  // Also try PATH
  try {
    const fromPath = execSync('which python3 2>/dev/null || true').toString().trim();
    if (fromPath) log('  which python3: ' + fromPath);
    if (!python3 && fromPath) python3 = fromPath;
  } catch(e) {}

  if (!python3) { log('ERROR: python3 not found anywhere!'); process.exit(1); }
  log('Using: ' + python3);

  // 3. Check python3 version
  try {
    const ver = execSync(python3 + ' --version 2>&1').toString().trim();
    log('Python version: ' + ver);
  } catch(e) { log('ERROR running python3: ' + e.message); }

  // 4. Check port free
  log('\nPort ' + PORT + ' before start: ' + (await checkPort(PORT) ? 'OCCUPIED' : 'free'));

  // 5. Spawn FlexBridge
  log('\nSpawning: ' + python3 + ' ' + fbScript);
  const env = { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin' };
  const proc = spawn(python3, [fbScript], {
    cwd: path.dirname(fbScript),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  proc.on('error', e => log('SPAWN ERROR: ' + e.message));
  proc.stdout.on('data', d => process.stdout.write('[FB out] ' + d));
  proc.stderr.on('data', d => process.stdout.write('[FB err] ' + d));
  proc.on('exit', (code, sig) => log('FlexBridge exited: code=' + code + ' signal=' + sig));

  log('PID: ' + proc.pid);

  // 6. Poll port
  log('\nWaiting for port ' + PORT + '...');
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 500));
    const open = await checkPort(PORT);
    log('  ' + ((i+1)*0.5).toFixed(1) + 's: port ' + (open ? 'OPEN ✓' : 'closed'));
    if (open) break;
  }

  // 7. HTTP test
  log('\nTesting HTTP /status...');
  const result = await checkHttp(PORT);
  if (result.ok) {
    log('HTTP OK (' + result.status + ')');
    log('Response: ' + result.body);
  } else {
    log('HTTP FAILED: ' + result.error);
  }

  log('\nDone. Stopping FlexBridge...');
  proc.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => { log('Fatal: ' + e.message); process.exit(1); });
