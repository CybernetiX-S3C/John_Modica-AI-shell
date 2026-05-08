'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── App ──────────────────────────────────────────────────────────────────
  getInfo: ()                     => ipcRenderer.invoke('app:info'),
  onNewChat:      (cb) => ipcRenderer.on('app:new-chat',      () => cb()),
  onNewTerminal:  (cb) => ipcRenderer.on('app:new-terminal',  () => cb()),
  onExportChat:   (cb) => ipcRenderer.on('app:export-chat',   () => cb()),
  onOpenSettings: (cb) => ipcRenderer.on('app:open-settings', () => cb()),
  onAbout:        (cb) => ipcRenderer.on('app:about',         () => cb()),
  onZoom:         (cb) => ipcRenderer.on('app:zoom',          (_, v) => cb(v)),
  onModeSet:      (cb) => ipcRenderer.on('mode:set',          (_, m) => cb(m)),

  // ── Terminal ──────────────────────────────────────────────────────────────
  terminal: {
    spawn:  (opts)        => ipcRenderer.invoke('terminal:spawn', opts),
    write:  (id, data)    => ipcRenderer.send('terminal:write',  { id, data }),
    resize: (id, c, r)    => ipcRenderer.send('terminal:resize', { id, cols: c, rows: r }),
    kill:   (id)          => ipcRenderer.send('terminal:kill',   { id }),
    onData: (cb)          => ipcRenderer.on('terminal:data', (_, d) => cb(d)),
    onExit: (cb)          => ipcRenderer.on('terminal:exit', (_, d) => cb(d))
  },

  // ── Database ──────────────────────────────────────────────────────────────
  db: {
    query: (sql, params, mode) => ipcRenderer.invoke('db:query', { sql, params, mode }),
    run:   (sql, params)       => ipcRenderer.invoke('db:query', { sql, params, mode: 'run' }),
    get:   (sql, params)       => ipcRenderer.invoke('db:query', { sql, params, mode: 'get' }),
    all:   (sql, params)       => ipcRenderer.invoke('db:query', { sql, params }),
    transaction: (ops)         => ipcRenderer.invoke('db:transaction', { operations: ops })
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    get:    (key)         => ipcRenderer.invoke('settings:get', key),
    set:    (key, value)  => ipcRenderer.invoke('settings:set', { key, value }),
    getAll: ()            => ipcRenderer.invoke('settings:getAll')
  },

  // ── AI streaming ──────────────────────────────────────────────────────────
  ai: {
    stream:  (requestId, url, payload, headers) =>
      ipcRenderer.send('ai:stream', { requestId, url, payload, headers }),
    onChunk: (cb) => ipcRenderer.on('ai:chunk', (_, d) => cb(d)),
    onDone:  (cb) => ipcRenderer.on('ai:done',  (_, d) => cb(d)),
    onError: (cb) => ipcRenderer.on('ai:error', (_, d) => cb(d))
  },

  // ── File system ───────────────────────────────────────────────────────────
  fs: {
    read:   (p)           => ipcRenderer.invoke('fs:readFile',  p),
    write:  (p, content)  => ipcRenderer.invoke('fs:writeFile', { filePath: p, content }),
    exists: (p)           => ipcRenderer.invoke('fs:exists',    p)
  }
});
