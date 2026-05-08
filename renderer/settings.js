// ─── settings.js ──────────────────────────────────────────────────────────────
// John Modica AI Shell — Settings Manager
//
// Handles:
//   • Loading settings from SQLite (via IPC)
//   • Saving / live-applying settings
//   • AI routing config (Ollama URL, cloud key, routing mode)
//   • AI Platforms config (default platform, inject behaviour, session clear)
//   • Terminal / Kali PTY config (shell path, cwd, font, scrollback)
//   • Voice engine config (local XTTS-v2 server, hotword, TTS toggle)
//   • Appearance (theme, accent colour, font size)
//   • Storage management (clear history, export)
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Default values ────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  // AI routing
  routingMode:           'local',
  ollamaUrl:             'http://localhost:11434',
  ollamaModel:           'tinyllama',
  cloudUrl:              'https://api.openai.com/v1',
  cloudApiKey:           '',
  cloudModel:            'gpt-4o-mini',

  // AI Platforms
  defaultPlatform:       'characterai',
  injectAutoSubmit:      'false',
  injectDelay:           '500',
  platformUserAgent:     'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // Terminal / Kali PTY
  termShell:             '/bin/bash',
  termCwd:               '/root',
  termFontSize:          '14',
  termScrollback:        '10000',
  termCursorBlink:       'true',
  termCursorStyle:       'bar',
  termKaliHints:         'true',

  // Voice
  voiceEnabled:          'false',
  voiceTTSEnabled:       'false',
  voiceLang:             'en-US',
  ttsServerUrl:          'http://localhost:5002',
  voiceSamplePath:       'assets/voices/john-voice.wav',
  hotwordEnabled:        'false',

  // Appearance
  theme:                 'dark',
  accentColor:           '#9b59b6',
  fontSize:              '14',
  sidebarCollapsed:      'false',
};

// ══════════════════════════════════════════════════════════════════════════════
class SettingsManager {
  constructor() {
    this.cache   = { ...SETTINGS_DEFAULTS };
    this._panel  = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════
  async init() {
    // Load from DB — merge on top of defaults
    try {
      const stored = await window.api.settings.getAll();
      this.cache = { ...SETTINGS_DEFAULTS, ...stored };
    } catch (e) {
      console.warn('[Settings] Could not load from DB — using defaults:', e.message);
    }

    this._panel = document.getElementById('panel-settings');
    this._populateInputs();
    this._bindInputs();
    this._bindButtons();
    this._applyTheme();
    this._applyFontSize();
    this._applySidebarCollapsed();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  RELOAD (refresh from DB, re-populate)
  // ══════════════════════════════════════════════════════════════════════════
  async reload() {
    try {
      const stored = await window.api.settings.getAll();
      this.cache = { ...SETTINGS_DEFAULTS, ...stored };
      this._populateInputs();
    } catch (_) { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GET / SET (shorthand)
  // ══════════════════════════════════════════════════════════════════════════
  get(key) {
    return this.cache[key] ?? SETTINGS_DEFAULTS[key] ?? null;
  }

  getBool(key) {
    const v = this.get(key);
    return v === 'true' || v === true;
  }

  getInt(key, fallback = 0) {
    return parseInt(this.get(key) || fallback, 10);
  }

  async set(key, value) {
    this.cache[key] = String(value);
    await window.api.settings.set(key, String(value));
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INPUT BINDING
  // ══════════════════════════════════════════════════════════════════════════
  _populateInputs() {
    document.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      const val = this.cache[key];
      if (val === undefined || val === null) return;
      if (el.type === 'checkbox') {
        el.checked = (val === 'true' || val === true);
      } else {
        el.value = val;
      }
    });
  }

  _bindInputs() {
    document.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      const ev  = (el.type === 'checkbox') ? 'change' : 'input';

      el.addEventListener(ev, () => {
        const val = (el.type === 'checkbox') ? String(el.checked) : el.value;
        this.cache[key] = val;
        this._liveApply(key, val);
      });
    });
  }

  // Live-apply settings that have immediate visual/functional effect
  _liveApply(key, val) {
    switch (key) {
      case 'accentColor':
        document.documentElement.style.setProperty('--purple-main', val);
        document.documentElement.style.setProperty('--purple-hi',   val);
        break;
      case 'fontSize':
        this._applyFontSize(parseInt(val, 10));
        break;
      case 'theme':
        this._applyTheme(val);
        break;
      case 'termFontSize':
        if (window.terminalManager) window.terminalManager.setFontSize(parseInt(val, 10));
        break;
      case 'voiceEnabled':
        const vbtn = document.getElementById('voice-btn');
        if (vbtn) vbtn.style.display = val === 'true' ? '' : 'none';
        break;
      case 'sidebarCollapsed':
        this._applySidebarCollapsed(val === 'true');
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BUTTON WIRING
  // ══════════════════════════════════════════════════════════════════════════
  _bindButtons() {
    // Save
    document.getElementById('settings-save')
      ?.addEventListener('click', () => this.save());

    // Ollama test
    document.getElementById('settings-test-ollama')
      ?.addEventListener('click', () => this._testOllama());

    // Cloud test
    document.getElementById('settings-test-cloud')
      ?.addEventListener('click', () => this._testCloud());

    // Clear conversation history
    document.getElementById('settings-clear-history')
      ?.addEventListener('click', () => this._clearHistory());

    // Export history
    document.getElementById('settings-export-history')
      ?.addEventListener('click', () => this._exportHistory());

    // Clear all platform sessions (clears partition cookies)
    document.getElementById('settings-clear-platform-sessions')
      ?.addEventListener('click', () => this._clearPlatformSessions());
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SAVE
  // ══════════════════════════════════════════════════════════════════════════
  async save() {
    // Collect every [data-key] element's current value
    const updates = {};
    document.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      updates[key] = (el.type === 'checkbox') ? String(el.checked) : el.value;
    });

    // Batch save to DB
    try {
      await storageManager.setSettings(updates);
      this.cache = { ...this.cache, ...updates };
    } catch (e) {
      window.appController?.toast('Settings save failed: ' + e.message, 'error');
      return;
    }

    // Apply everything
    this._applyTheme();
    this._applyFontSize();
    this._applySidebarCollapsed();

    // Refresh AI router with new settings
    if (window.aiRouter) await window.aiRouter.refreshSettings();

    // Refresh voice engine
    if (window.voiceEngine) {
      window.voiceEngine.ttsEnabled        = this.getBool('voiceTTSEnabled');
      window.voiceEngine.hotwordEnabled    = this.getBool('hotwordEnabled');
      // Notify XTTS server of new voice sample path if changed
      if (updates.voiceSamplePath && window.voiceEngine?.xttsAvailable) {
        fetch('http://localhost:5002/set-voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voice_sample: updates.voiceSamplePath }),
        }).catch(() => {});
      }
    }

    // Update platform manager default platform selection
    if (window.platformManager && updates.defaultPlatform) {
      // Only auto-switch if the platforms panel is active
      const platformPanel = document.getElementById('panel-platforms');
      if (platformPanel?.classList.contains('active')) {
        window.platformManager.switchPlatform(updates.defaultPlatform);
      }
    }

    window.appController?.toast('Settings saved ✓', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  OLLAMA CONNECTION TEST
  // ══════════════════════════════════════════════════════════════════════════
  async _testOllama() {
    const resultEl = document.getElementById('ollama-test-result');
    if (resultEl) { resultEl.textContent = 'Testing…'; resultEl.className = 'test-result'; }

    try {
      const url    = (this.get('ollamaUrl') || 'http://localhost:11434').replace(/\/$/, '');
      const result = await window.api.ai.testConnection({ type: 'ollama', url });

      if (result.ok) {
        const models = (result.models || []).join(', ') || 'none';
        if (resultEl) { resultEl.textContent = `✓ Connected — models: ${models}`; resultEl.className = 'test-result ok'; }
        window.appController?.toast(`Ollama OK — ${result.models?.length || 0} model(s)`, 'success');
      } else {
        throw new Error(result.error || 'Connection failed');
      }
    } catch (e) {
      if (resultEl) { resultEl.textContent = `✗ ${e.message}`; resultEl.className = 'test-result error'; }
      window.appController?.toast('Ollama test failed: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CLOUD CONNECTION TEST
  // ══════════════════════════════════════════════════════════════════════════
  async _testCloud() {
    const resultEl = document.getElementById('cloud-test-result');
    if (resultEl) { resultEl.textContent = 'Testing…'; resultEl.className = 'test-result'; }

    const url   = this.get('cloudUrl')    || '';
    const key   = this.get('cloudApiKey') || '';
    const model = this.get('cloudModel')  || 'gpt-4o-mini';

    if (!url || !key) {
      if (resultEl) { resultEl.textContent = '✗ URL and API key required'; resultEl.className = 'test-result error'; }
      return;
    }

    try {
      const result = await window.api.ai.testConnection({ type: 'openai', url, key, model });
      if (result.ok) {
        if (resultEl) { resultEl.textContent = `✓ Connected (${model})`; resultEl.className = 'test-result ok'; }
        window.appController?.toast(`Cloud AI OK — ${model}`, 'success');
      } else {
        throw new Error(result.error || 'Connection failed');
      }
    } catch (e) {
      if (resultEl) { resultEl.textContent = `✗ ${e.message}`; resultEl.className = 'test-result error'; }
      window.appController?.toast('Cloud test failed: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CLEAR HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  async _clearHistory() {
    const confirmed = await window.appController?.confirm(
      'Delete ALL conversation history?',
      'This cannot be undone. All messages and conversations will be permanently removed.'
    );
    if (!confirmed) return;

    try {
      await storageManager.deleteAllConversations();
      if (window.appController) {
        window.appController.messages    = [];
        window.appController.activeConvId = null;
        await window.appController.loadHistory();
        await window.appController.newChat();
      }
      window.appController?.toast('All conversation history cleared.', 'success');
    } catch (e) {
      window.appController?.toast('Clear failed: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EXPORT HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  async _exportHistory() {
    try {
      const conversations = await storageManager.getConversations(500);
      const full = [];
      for (const conv of conversations) {
        const messages = await storageManager.getMessages(conv.id);
        full.push({ ...conv, messages });
      }

      const json     = JSON.stringify(full, null, 2);
      const blob     = new Blob([json], { type: 'application/json' });
      const url      = URL.createObjectURL(blob);
      const a        = document.createElement('a');
      a.href         = url;
      a.download     = `john-modica-ai-history-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      window.appController?.toast(`Exported ${conversations.length} conversations.`, 'success');
    } catch (e) {
      window.appController?.toast('Export failed: ' + e.message, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CLEAR PLATFORM SESSIONS
  //  Each platform uses a named persist:// partition in Electron.
  //  Clearing the session wipes cookies → user must re-login.
  // ══════════════════════════════════════════════════════════════════════════
  async _clearPlatformSessions() {
    const confirmed = await window.appController?.confirm(
      'Clear all platform sessions?',
      'You will be logged out of Character AI, Blackbox AI, Gemini, and all other embedded platforms.'
    );
    if (!confirmed) return;

    const partitions = [
      'persist:characterai',
      'persist:blackbox',
      'persist:gemini',
      'persist:huggingchat',
      'persist:chatgpt',
      'persist:claude',
    ];

    // Ask main process to clear each session partition
    try {
      for (const partition of partitions) {
        await window.api.clearSession(partition);
      }
      // Reload all platform webviews
      if (window.platformManager) {
        for (const [id] of Object.entries(window.platformManager.PLATFORM_IDS || {})) {
          window.platformManager.reloadPlatform?.(id);
        }
        // Simpler: reload the active platform
        window.platformManager.reload?.();
      }
      window.appController?.toast('All platform sessions cleared. Please log in again.', 'success');
    } catch (e) {
      // Fallback: reload webviews which will trigger login
      window.platformManager?.reload?.();
      window.appController?.toast('Sessions cleared. Please log in again.', 'info');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  THEME APPLICATION
  // ══════════════════════════════════════════════════════════════════════════
  _applyTheme(theme) {
    const t = theme || this.get('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', t);

    // Apply accent colour
    const accent = this.get('accentColor') || '#9b59b6';
    document.documentElement.style.setProperty('--purple-main', accent);
    document.documentElement.style.setProperty('--purple-hi',   accent);

    // Specific theme overrides
    switch (t) {
      case 'darker':
        document.documentElement.style.setProperty('--bg-0', '#000000');
        document.documentElement.style.setProperty('--bg-1', '#080808');
        break;
      case 'light':
        document.documentElement.style.setProperty('--bg-0', '#f0f0f0');
        document.documentElement.style.setProperty('--bg-1', '#ffffff');
        document.documentElement.style.setProperty('--text-1', '#1a1a1a');
        break;
      default: // dark
        document.documentElement.style.setProperty('--bg-0', '#0d0d0d');
        document.documentElement.style.setProperty('--bg-1', '#141414');
        document.documentElement.style.setProperty('--text-1', '#e8e8e8');
    }
  }

  _applyFontSize(size) {
    const s = size || parseInt(this.get('fontSize') || 14, 10);
    document.documentElement.style.fontSize = `${s}px`;
  }

  _applySidebarCollapsed(force) {
    const collapsed = force !== undefined ? force : this.getBool('sidebarCollapsed');
    const sidebar   = document.getElementById('sidebar');
    const toggle    = document.getElementById('sidebar-toggle');
    if (sidebar) sidebar.classList.toggle('collapsed', collapsed);
    if (toggle)  toggle.textContent = collapsed ? '›' : '‹';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  GETALL (shorthand for aiRouter.refreshSettings)
  // ══════════════════════════════════════════════════════════════════════════
  getAll() {
    return { ...this.cache };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const settingsManager = new SettingsManager();
if (typeof window !== 'undefined') window.settingsManager = settingsManager;
