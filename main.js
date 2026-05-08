'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, shell, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');

// ─── App constants ────────────────────────────────────────────────────────────
const APP_NAME    = 'John Modica AI';
const APP_VERSION = '2.0.0';
const IS_DEV      = process.argv.includes('--dev');
const DATA_DIR    = path.join(app.getPath('userData'), 'john-modica-ai');
const DB_PATH     = path.join(DATA_DIR, 'modica.db');
const LOG_PATH    = path.join(DATA_DIR, 'app.log');

// ─── Ensure data dir ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Simple logger ────────────────────────────────────────────────────────────
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  fs.appendFileSync(LOG_PATH, line);
  if (IS_DEV) process.stdout.write(line);
}

// ─── SQLite database init ─────────────────────────────────────────────────────
let db;
function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT 'New Chat',
      mode TEXT DEFAULT 'general',
      model TEXT DEFAULT 'tinyllama',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT,
      model TEXT,
      token_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plugins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      version TEXT,
      enabled INTEGER DEFAULT 1,
      manifest TEXT,
      installed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      active_mode TEXT,
      message_count INTEGER DEFAULT 0
    );
  `);

  // Default settings
  const defaults = {
    ollamaUrl:     'http://localhost:11434',
    ollamaModel:   'tinyllama',
    cloudProvider: 'openai',
    cloudApiKey:   '',
    cloudModel:    'gpt-4o',
    cloudUrl:      'https://api.openai.com/v1',
    routingMode:   'local',   // local | cloud | auto
    activeMode:    'general',
    theme:         's3c',
    fontSize:      '14',
    voiceEnabled:  'false',
    cpuOnly:       'true',
    streamEnabled: 'true',
    accentColor:   '#9b59b6'
  };
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const insertMany = db.transaction((pairs) => {
    for (const [k, v] of Object.entries(pairs)) insertSetting.run(k, v);
  });
  insertMany(defaults);
  log('INFO', 'Database initialised: ' + DB_PATH);
}

// ─── PTY sessions map ─────────────────────────────────────────────────────────
const ptyProcesses = new Map();
let ptyCounter = 0;

function spawnPTY(win, shell_path, cwd) {
  const id = ++ptyCounter;
  const shellExec = shell_path || (os.platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash'));
  const proc = pty.spawn(shellExec, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'john-modica-ai'
    }
  });

  proc.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('terminal:data', { id, data });
  });

  proc.onExit(({ exitCode }) => {
    ptyProcesses.delete(id);
    if (!win.isDestroyed()) win.webContents.send('terminal:exit', { id, exitCode });
    log('INFO', `PTY ${id} exited with code ${exitCode}`);
  });

  ptyProcesses.set(id, proc);
  log('INFO', `PTY ${id} spawned: ${shellExec} in ${cwd || os.homedir()}`);
  return id;
}

// ─── Main window ──────────────────────────────────────────────────────────────
let mainWindow;
let tray;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  800,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    },
    frame: true,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('close', (e) => {
    // Kill all PTYs on close
    for (const [, proc] of ptyProcesses) {
      try { proc.kill(); } catch (_) {}
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const img = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: `${APP_NAME} v${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => mainWindow.show() },
    { label: 'Hide', click: () => mainWindow.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow.show());
}

// ─── App menu ────────────────────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Chat',         accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('app:new-chat') },
        { label: 'New Terminal Tab', accelerator: 'CmdOrCtrl+T', click: () => mainWindow.webContents.send('app:new-terminal') },
        { type: 'separator' },
        { label: 'Export Chat...',   accelerator: 'CmdOrCtrl+E', click: () => mainWindow.webContents.send('app:export-chat') },
        { type: 'separator' },
        { label: 'Quit',             accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload',             accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: 'Toggle DevTools',    accelerator: 'F12',          click: () => mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Zoom In',  accelerator: 'CmdOrCtrl+=', click: () => mainWindow.webContents.send('app:zoom', 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => mainWindow.webContents.send('app:zoom', -1) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.send('app:zoom', 0) }
      ]
    },
    {
      label: 'Mode',
      submenu: [
        { label: 'General',         click: () => mainWindow.webContents.send('mode:set', 'general') },
        { label: 'Code Assistant',  click: () => mainWindow.webContents.send('mode:set', 'code') },
        { label: 'Cybersecurity',   click: () => mainWindow.webContents.send('mode:set', 'cybersecurity') },
        { label: 'Research',        click: () => mainWindow.webContents.send('mode:set', 'research') },
        { label: 'Terminal/DevOps', click: () => mainWindow.webContents.send('mode:set', 'devops') },
        { label: 'OSINT',           click: () => mainWindow.webContents.send('mode:set', 'osint') },
        { label: 'Pen Tester',      click: () => mainWindow.webContents.send('mode:set', 'pentest') }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        { label: 'Preferences', accelerator: 'CmdOrCtrl+,', click: () => mainWindow.webContents.send('app:open-settings') }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About', click: () => mainWindow.webContents.send('app:about') },
        { label: 'GitHub', click: () => shell.openExternal('https://github.com') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Terminal
ipcMain.handle('terminal:spawn', (e, { shell: sh, cwd }) => {
  const id = spawnPTY(mainWindow, sh, cwd);
  return { id };
});

ipcMain.on('terminal:write', (e, { id, data }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.write(data);
});

ipcMain.on('terminal:resize', (e, { id, cols, rows }) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.resize(cols, rows);
});

ipcMain.on('terminal:kill', (e, { id }) => {
  const proc = ptyProcesses.get(id);
  if (proc) { try { proc.kill(); } catch (_) {} ptyProcesses.delete(id); }
});

// Storage
ipcMain.handle('db:query', (e, { sql, params, mode }) => {
  try {
    const stmt = db.prepare(sql);
    if (mode === 'run')  return stmt.run(...(params || []));
    if (mode === 'get')  return stmt.get(...(params || []));
    return stmt.all(...(params || []));
  } catch (err) {
    log('ERROR', `DB error: ${err.message} | SQL: ${sql}`);
    throw err;
  }
});

ipcMain.handle('db:transaction', (e, { operations }) => {
  const txn = db.transaction(() => {
    const results = [];
    for (const op of operations) {
      const stmt = db.prepare(op.sql);
      if (op.mode === 'run') results.push(stmt.run(...(op.params || [])));
      else results.push(stmt.all(...(op.params || [])));
    }
    return results;
  });
  return txn();
});

// Settings
ipcMain.handle('settings:get', (e, key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
});

ipcMain.handle('settings:set', (e, { key, value }) => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  return true;
});

ipcMain.handle('settings:getAll', () => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
});

// AI streaming proxy (avoids CORS from renderer)
ipcMain.on('ai:stream', async (e, { requestId, url, payload, headers }) => {
  try {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ ...payload, stream: true });

    const req = lib.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      res.on('data', (chunk) => {
        mainWindow.webContents.send('ai:chunk', { requestId, chunk: chunk.toString() });
      });
      res.on('end', () => {
        mainWindow.webContents.send('ai:done', { requestId });
      });
    });

    req.on('error', (err) => {
      mainWindow.webContents.send('ai:error', { requestId, error: err.message });
    });

    req.write(body);
    req.end();
  } catch (err) {
    mainWindow.webContents.send('ai:error', { requestId, error: err.message });
  }
});

// App info
ipcMain.handle('app:info', () => ({
  name:     APP_NAME,
  version:  APP_VERSION,
  platform: os.platform(),
  arch:     os.arch(),
  homedir:  os.homedir(),
  dataDir:  DATA_DIR,
  shell:    process.env.SHELL || 'unknown'
}));

// File system helpers
ipcMain.handle('fs:readFile', (e, filePath) => {
  return fs.readFileSync(filePath, 'utf8');
});

ipcMain.handle('fs:writeFile', (e, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('fs:exists', (e, filePath) => fs.existsSync(filePath));

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initDB();
  createWindow();
  createTray();
  createMenu();
  log('INFO', `${APP_NAME} v${APP_VERSION} started`);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const [, proc] of ptyProcesses) {
    try { proc.kill(); } catch (_) {}
  }
  if (db) db.close();
  log('INFO', 'App shutting down.');
});
