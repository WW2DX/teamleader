'use strict';

const { app, BrowserWindow, Menu, shell, dialog, nativeImage, ipcMain, Tray } = require('electron');
const path   = require('path');
const net    = require('net');
const { fork, spawn } = require('child_process');
const os     = require('os');

// ── Constants ──────────────────────────────────────────────────────────────────
const SERVER_PORT  = 7375;
const SERVER_ENTRY = path.join(__dirname, '..', 'server.js');
const APP_NAME     = 'Team Leader';
const IS_MAC       = process.platform === 'darwin';
const IS_LINUX     = process.platform === 'linux';

// Override the macOS menu bar / dock label so it reads "Team Leader" instead
// of "Electron" when running unpackaged (dev mode). Must be called before
// app.whenReady() and before any BrowserWindow / Menu is created.
app.setName(APP_NAME);
if (IS_MAC) {
  // Cocoa caches the process display name from argv[0] very early; setting
  // process.title here updates the activity monitor / `ps` listing too.
  process.title = APP_NAME;
}

// Customise the standard macOS About panel (triggered by the {role:'about'}
// menu item). Linux/Windows ignore most of these fields and fall back to the
// custom Help → About dialog further down.
const PKG = require('../package.json');
app.setAboutPanelOptions({
  applicationName:    APP_NAME,
  applicationVersion: PKG.version,
  version:            `Build ${PKG.version}`,
  copyright:          'Built by DXpeditioners, for DXpeditioners.\nVibe coded by WW2DX.',
  credits:            'Multi-operator peer-mesh DXpedition logger.\nhttps://github.com/WW2DX/teamleader',
  authors:            ['Lee J. Imber, WW2DX'],
  website:            'https://github.com/WW2DX/teamleader',
});

// ── State ──────────────────────────────────────────────────────────────────────
let mainWindow   = null;
let tray         = null;
let serverProc   = null;
let serverReady  = false;

// ── Server lifecycle ───────────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    console.log('[App] Starting Team Leader server…');

    serverProc = fork(SERVER_ENTRY, [], {
      cwd:   path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env:   { ...process.env, ELECTRON_RUN: '1' },
    });

    serverProc.stdout?.on('data', d => process.stdout.write('[Server] ' + d));
    serverProc.stderr?.on('data', d => process.stderr.write('[Server] ' + d));

    serverProc.on('exit', (code) => {
      console.log(`[App] Server exited (${code})`);
      serverProc   = null;
      serverReady  = false;
    });

    serverProc.on('error', err => {
      console.error('[App] Server error:', err);
      reject(err);
    });

    // Poll until port is open
    let attempts = 0;
    const check = () => {
      const sock = new net.Socket();
      sock.setTimeout(300);
      sock.connect(SERVER_PORT, '127.0.0.1', () => {
        sock.destroy();
        serverReady = true;
        console.log(`[App] Server ready on port ${SERVER_PORT}`);
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (++attempts < 40) {
          setTimeout(check, 250);
        } else {
          reject(new Error(`Server did not start on port ${SERVER_PORT}`));
        }
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (++attempts < 40) setTimeout(check, 250);
        else reject(new Error('Server timeout'));
      });
    };
    setTimeout(check, 500); // brief head-start
  });
}

function stopServer() {
  if (serverProc) {
    try { serverProc.kill('SIGTERM'); } catch {}
    serverProc = null;
  }
}

// ── Window ─────────────────────────────────────────────────────────────────────
function createWindow() {
  const iconPath = IS_MAC
    ? path.join(__dirname, 'build', 'icon.icns')
    : path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title:  APP_NAME,
    icon:   iconPath,
    backgroundColor: '#1e3a5f',
    titleBarStyle: 'default',
    titleBarOverlay: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false, // show after loaded
  });

  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in real browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${SERVER_PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Show DevTools in dev mode
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function createTray() {
  const iconFile = IS_MAC
    ? path.join(__dirname, 'build', 'tray-icon.png')
    : path.join(__dirname, 'build', 'icon.png');

  try {
    const img = nativeImage.createFromPath(iconFile);
    if (IS_MAC) img.setTemplateImage(true); // auto dark/light mode
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    updateTrayMenu();
    tray.on('double-click', () => showWindow());
  } catch (e) {
    console.warn('[App] Tray icon not found — tray disabled');
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const template = [
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: 'Show Logger',   click: () => showWindow() },
    { label: 'Settings',      click: () => openSettings() },
    { label: 'Statistics',    click: () => openStats() },
    { type: 'separator' },
    { label: 'Quit Team Leader', click: () => quitApp() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function openSettings() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/settings.html`);
  }
}

function openStats() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/stats.html`);
  }
}

// ── Menu ───────────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    // macOS app menu
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Team Leader', accelerator: 'Cmd+Q', click: quitApp },
      ],
    }] : []),
    {
      label: 'Logger',
      submenu: [
        { label: 'Open Logger',   accelerator: IS_MAC ? 'Cmd+1' : 'Ctrl+1', click: () => mainWindow?.loadURL(`http://127.0.0.1:${SERVER_PORT}`) },
        { label: 'Open Settings', accelerator: IS_MAC ? 'Cmd+,' : 'Ctrl+,', click: openSettings },
        { label: 'Statistics',    accelerator: IS_MAC ? 'Cmd+2' : 'Ctrl+2', click: openStats },
        { type: 'separator' },
        { label: 'Export ADIF',   click: () => mainWindow?.webContents.executeJavaScript('doExport && doExport()') },
        { type: 'separator' },
        { label: 'Check for Updates…', click: updateFromGitHub },
        ...(!IS_MAC ? [{ type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Q', click: quitApp }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: IS_MAC ? 'Cmd+R' : 'Ctrl+R', click: () => mainWindow?.reload() },
        { label: 'Force Reload', accelerator: IS_MAC ? 'Cmd+Shift+R' : 'Ctrl+Shift+R', click: () => mainWindow?.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: IS_MAC ? 'Cmd+Alt+I' : 'Ctrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(IS_MAC ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Team Leader', click: () => {
          dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'About Team Leader',
            message: `Team Leader  v${PKG.version}`,
            detail:  'DXpedition Logger\n\n' +
                     'Built by DXpeditioners, for DXpeditioners.\n' +
                     'Vibe coded by WW2DX.\n\n' +
                     'Multi-operator peer-mesh logging system\n' +
                     'with FlexRadio TCI, CW keyer, WSJT-X bridge,\n' +
                     'and Clublog live streaming.',
            buttons: ['OK'],
          });
        }},
        { type: 'separator' },
        { label: 'Open in Browser', click: () => shell.openExternal(`http://127.0.0.1:${SERVER_PORT}`) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Update from GitHub ────────────────────────────────────────────────────────
async function updateFromGitHub() {
  const { execSync } = require('child_process');
  const repoDir = path.join(__dirname, '..');

  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Update Team Leader',
    message: 'Pull latest from GitHub and restart?',
    detail: 'This will:\n• git pull origin master\n• npm install (if needed)\n• Restart Team Leader\n\nMake sure you have network connectivity.',
    buttons: ['Update & Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) return;

  // Show progress
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript(
      `document.title='Updating…'; document.body.style.opacity='0.5';`
    ).catch(() => {});
  }

  try {
    console.log('[Update] Pulling latest from GitHub…');
    const pullOut = execSync('git pull origin master', {
      cwd: repoDir, timeout: 30000, encoding: 'utf8',
    }).trim();
    console.log('[Update] git pull:', pullOut);

    // Check if package.json changed (need npm install)
    const diffOut = execSync('git diff HEAD~1 --name-only', {
      cwd: repoDir, timeout: 5000, encoding: 'utf8',
    }).trim();
    if (diffOut.includes('package.json') || diffOut.includes('package-lock.json')) {
      console.log('[Update] package.json changed — running npm install…');
      execSync('npm install --production', {
        cwd: repoDir, timeout: 60000, encoding: 'utf8',
      });
      console.log('[Update] npm install complete');
    }

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Complete',
      message: 'Update successful — restarting now.',
      detail: pullOut,
      buttons: ['OK'],
    });

    // Restart: relaunch the app and quit the current instance
    app.relaunch();
    app.quit();

  } catch (err) {
    console.error('[Update] Failed:', err.message);
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(
        `document.title='Team Leader'; document.body.style.opacity='1';`
      ).catch(() => {});
    }
    dialog.showErrorBox('Update Failed',
      `Could not update Team Leader:\n\n${err.message}\n\nCheck your network connection and try again.`);
  }
}

// ── Quit ───────────────────────────────────────────────────────────────────────
function quitApp() {
  stopServer();
  app.quit();
}

// ── App events ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  buildMenu();

  // Start server, then create window
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('Startup Error', `Team Leader server failed to start:\n\n${err.message}`);
    app.quit();
    return;
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    // macOS: re-create window if dock icon clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS: stay running in tray when all windows closed
  if (!IS_MAC) quitApp();
});

app.on('before-quit', () => {
  stopServer();
});

// IPC from renderer
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
