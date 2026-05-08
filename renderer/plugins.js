// ─── plugins.js ───────────────────────────────────────────────────────────────
// Plugin manager — discovery, loading, lifecycle, UI rendering.
// ─────────────────────────────────────────────────────────────────────────────

class PluginManager {
  constructor() {
    this.plugins    = new Map(); // name -> { manifest, instance, enabled }
    this.hooks      = new Map(); // hookName -> [fn, ...]
    this.builtins   = this._defineBuiltins();
  }

  // ── Built-in plugins ───────────────────────────────────────────────────────
  _defineBuiltins() {
    return [
      {
        manifest: { name: 'Clipboard Monitor', version: '1.0', author: 'MODICA', icon: '📋',
                    description: 'Monitors clipboard and offers to analyse copied text with AI.' },
        factory: () => ({
          onActivate() {
            let last = '';
            this._interval = setInterval(async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text && text !== last && text.length > 10 && text.length < 8000) {
                  last = text;
                  // Show a toast offering AI analysis
                  if (window.appController) {
                    window.appController.toastWithAction(
                      `Clipboard updated (${text.length} chars)`,
                      'Analyse',
                      () => window.appController.sendMessage(`Analyse this:\n\`\`\`\n${text.slice(0, 4000)}\n\`\`\``)
                    );
                  }
                }
              } catch (_) { /* clipboard read requires focus */ }
            }, 3000);
          },
          onDeactivate() { clearInterval(this._interval); }
        })
      },
      {
        manifest: { name: 'Quick Notes', version: '1.0', author: 'MODICA', icon: '📝',
                    description: 'Scratch-pad notes stored locally. Access via /note command.' },
        factory: () => ({
          notes: [],
          async onActivate() {
            const raw = await window.api.settings.get('plugin_notes');
            this.notes = raw ? JSON.parse(raw) : [];
          },
          async save() {
            await window.api.settings.set('plugin_notes', JSON.stringify(this.notes.slice(-100)));
          },
          addNote(text) {
            this.notes.push({ text, ts: new Date().toISOString() });
            this.save();
            window.appController?.toast('Note saved.', 'success');
          }
        })
      },
      {
        manifest: { name: 'Session Timer', version: '1.0', author: 'MODICA', icon: '⏱',
                    description: 'Tracks time spent in each session and displays it in the status bar.' },
        factory: () => ({
          start: null,
          _interval: null,
          onActivate() {
            this.start = Date.now();
            this._interval = setInterval(() => {
              const secs  = Math.floor((Date.now() - this.start) / 1000);
              const h     = String(Math.floor(secs / 3600)).padStart(2, '0');
              const m     = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
              const s     = String(secs % 60).padStart(2, '0');
              const el    = document.getElementById('status-tokens');
              if (el) el.textContent = `${h}:${m}:${s}`;
            }, 1000);
          },
          onDeactivate() { clearInterval(this._interval); }
        })
      }
    ];
  }

  async init() {
    // Load builtins
    for (const def of this.builtins) {
      const inst = def.factory();
      this.plugins.set(def.manifest.name, {
        manifest: def.manifest,
        instance: inst,
        enabled:  true,
        builtin:  true
      });
      if (inst.onActivate) inst.onActivate();
    }
    this._renderUI();
  }

  register(name, manifest, factory) {
    const inst = factory();
    this.plugins.set(name, { manifest, instance: inst, enabled: false, builtin: false });
    this._renderUI();
  }

  enable(name) {
    const p = this.plugins.get(name);
    if (!p || p.enabled) return;
    p.enabled = true;
    if (p.instance.onActivate) p.instance.onActivate();
    this._renderUI();
    window.appController?.toast(`Plugin "${name}" enabled.`, 'success');
  }

  disable(name) {
    const p = this.plugins.get(name);
    if (!p || !p.enabled) return;
    p.enabled = false;
    if (p.instance.onDeactivate) p.instance.onDeactivate();
    this._renderUI();
    window.appController?.toast(`Plugin "${name}" disabled.`, 'info');
  }

  toggle(name) {
    const p = this.plugins.get(name);
    if (!p) return;
    p.enabled ? this.disable(name) : this.enable(name);
  }

  // ── Hook system ────────────────────────────────────────────────────────────
  on(hookName, fn) {
    if (!this.hooks.has(hookName)) this.hooks.set(hookName, []);
    this.hooks.get(hookName).push(fn);
  }

  async emit(hookName, payload) {
    const fns = this.hooks.get(hookName) || [];
    let result = payload;
    for (const fn of fns) {
      try { result = await fn(result) ?? result; }
      catch (e) { console.warn(`[Plugin hook "${hookName}"] Error:`, e.message); }
    }
    return result;
  }

  // ── UI ─────────────────────────────────────────────────────────────────────
  _renderUI() {
    const list = document.getElementById('plugins-list');
    if (!list) return;
    list.innerHTML = '';
    for (const [name, p] of this.plugins) {
      const card = document.createElement('div');
      card.className = 'plugin-card';
      card.innerHTML = `
        <div class="plugin-icon">${p.manifest.icon || '🔌'}</div>
        <div class="plugin-info">
          <strong>${p.manifest.name}</strong>
          <small>${p.manifest.description || ''}</small>
          <div class="plugin-version">v${p.manifest.version} · ${p.manifest.author}${p.builtin ? ' · built-in' : ''}</div>
        </div>
        <label class="toggle" title="${p.enabled ? 'Disable' : 'Enable'}">
          <input type="checkbox" ${p.enabled ? 'checked' : ''}/>
          <span class="toggle-slider"></span>
        </label>`;
      const chk = card.querySelector('input[type=checkbox]');
      chk.addEventListener('change', () => this.toggle(name));
      list.appendChild(card);
    }
    if (this.plugins.size === 0) {
      list.innerHTML = '<p style="color:var(--text-3);padding:20px;">No plugins installed.</p>';
    }
  }
}

const pluginManager = new PluginManager();
if (typeof window !== 'undefined') window.pluginManager = pluginManager;
