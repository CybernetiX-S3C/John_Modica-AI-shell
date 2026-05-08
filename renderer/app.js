// ─── app.js ───────────────────────────────────────────────────────────────────
// John Modica AI Shell — Master renderer controller v2.0
// Boots all subsystems, wires all UI, handles all checklist features.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

class AppController {
  constructor() {
    this.activePanel      = 'chat';
    this.activeConvId     = null;
    this.messages         = [];       // [{role,content}] current conversation
    this.isStreaming      = false;
    this.streamBuffer     = '';
    this.sessionTokens    = 0;
    this.totalTokens      = 0;
    this.appInfo          = null;
    this.slashCommands    = new Map(); // registered by plugins
    this.shortcuts        = [];        // [{keys, description, action}]
    this._shortcutsVisible= false;
    this._firstRun        = false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BOOT
  // ══════════════════════════════════════════════════════════════════════════
  async boot() {
    try {
      this._setLoading('Loading settings…');
      await settingsManager.init();

      this._setLoading('Initialising AI router…');
      await aiRouter.init();

      this._setLoading('Loading voice…');
      // Basic voice (Web Speech)
      await voiceManager.loadEnabled();
      // Advanced voice engine
      await voiceEngine.init();
      voiceEngine.onTranscript = (text, isFinal) => {
        if (!isFinal) return;
        const input = document.getElementById('chat-input');
        if (input) { input.value = text; input.dispatchEvent(new Event('input')); }
        if (isFinal && text) setTimeout(() => this.sendMessage(text), 150);
      };

      this._setLoading('Starting terminal…');
      terminalManager.init();

      this._setLoading('Loading browser…');
      webViewManager.init();

      this._setLoading('Loading plugins…');
      await pluginManager.init();
      // Register plugin slash commands into our map
      pluginManager.on('registerSlashCommand', ({ cmd, fn }) => {
        this.slashCommands.set(cmd, fn);
      });

      this._setLoading('Loading history…');
      await this.loadHistory();

      this._setLoading('Getting app info…');
      this.appInfo = await window.api.getInfo();

      this._wireUI();
      this._wireMenuEvents();
      this._wireShortcuts();
      this._updateStatus();

      // Check first run
      const fr = await window.api.settings.get('firstRun');
      if (!fr || fr === 'true') {
        this._firstRun = true;
        window.api.settings.set('firstRun', 'false');
      }

      if (!this.activeConvId) await this.newChat();

      // Spawn background terminal (don't switch to it)
      await terminalManager.newTab();

      // Health check Ollama silently
      this._checkOllamaHealth();

      // First-run wizard
      if (this._firstRun) setTimeout(() => this._showFirstRunWizard(), 800);

      // Dismiss loading
      setTimeout(() => {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
          overlay.style.opacity     = '0';
          overlay.style.transition  = 'opacity 0.5s ease';
          setTimeout(() => overlay.remove(), 500);
        }
      }, 700);

      console.log('[MODICA] Boot complete.', this.appInfo);

    } catch (err) {
      console.error('[MODICA] Boot failed:', err);
      this._setLoading('⚠ Boot error: ' + err.message);
      document.getElementById('loading-sub').style.color = '#ef4444';
    }
  }

  _setLoading(msg) {
    const el = document.getElementById('loading-sub');
    if (el) el.textContent = msg;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI WIRING
  // ══════════════════════════════════════════════════════════════════════════
  _wireUI() {
    // ── Sidebar nav ──────────────────────────────────────────────────────
    document.querySelectorAll('.nav-item[data-panel]').forEach(el => {
      el.addEventListener('click', () => this.switchPanel(el.dataset.panel));
    });

    // Sidebar collapse toggle
    document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
      const sb  = document.getElementById('sidebar');
      const btn = document.getElementById('sidebar-toggle');
      sb.classList.toggle('collapsed');
      btn.textContent = sb.classList.contains('collapsed') ? '›' : '‹';
    });

    // ── Mode selector ────────────────────────────────────────────────────
    document.getElementById('mode-select')?.addEventListener('change', (e) => {
      this.setMode(e.target.value);
    });

    // ── Chat controls ────────────────────────────────────────────────────
    document.getElementById('new-chat-btn')?.addEventListener('click', () => this.newChat());
    document.getElementById('send-btn')?.addEventListener('click', () => this._handleSend());

    // Chat input — auto-grow, token counter, Enter to send
    const chatInput = document.getElementById('chat-input');
    chatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSend(); }
    });
    chatInput?.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px';
      const est = Math.ceil((chatInput.value.length) / 4);
      const el  = document.getElementById('prompt-tokens');
      if (el) el.textContent = `~${est} tok`;
    });

    // ── Voice buttons ────────────────────────────────────────────────────
    document.getElementById('voice-btn')?.addEventListener('click', () => {
      voiceEngine.toggleMic();
    });
    document.getElementById('tts-toggle-btn')?.addEventListener('click', () => {
      voiceEngine.toggleTTS();
    });

    // ── Tab bar new tab ──────────────────────────────────────────────────
    document.getElementById('new-tab-btn')?.addEventListener('click', () => {
      this.switchPanel('terminal');
      terminalManager.newTab();
    });

    // ── Regenerate last message ──────────────────────────────────────────
    document.getElementById('regenerate-btn')?.addEventListener('click', () => this._regenerate());

    // ── Clear conversation ────────────────────────────────────────────────
    document.getElementById('clear-chat-btn')?.addEventListener('click', () => this._clearConversation());

    // ── Export chat ──────────────────────────────────────────────────────
    document.getElementById('export-chat-btn')?.addEventListener('click', () => this.exportCurrentChat());

    // ── Modal close ──────────────────────────────────────────────────────
    document.getElementById('modal-close-btn')?.addEventListener('click', () => this.closeModal());
    document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') this.closeModal();
    });

    // ── Sidebar mode buttons (one-click mode activation) ─────────────────
    document.querySelectorAll('.mode-btn[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modeId = btn.dataset.mode;
        this.setMode(modeId);
        // Highlight active mode button
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active-mode'));
        btn.classList.add('active-mode');
      });
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
      });
    });

    // ── Mic button — request mic access on click ──────────────────────────
    document.getElementById('voice-btn')?.addEventListener('click', async () => {
      const ve = window.voiceEngine;
      if (!ve) return;
      // First click: request mic access
      if (!ve.mediaStream) {
        const granted = await ve.requestMicAccess();
        if (granted) {
          window.appController?.toast('🎤 Microphone access granted!', 'success');
        }
        return;
      }
      ve.toggleMic();
    });

    // ── TTS toggle button ─────────────────────────────────────────────────
    document.getElementById('tts-toggle-btn')?.addEventListener('click', () => {
      window.voiceEngine?.toggleTTS();
    });

  }

  // ── Menu events from main process ─────────────────────────────────────────
  _wireMenuEvents() {
    window.api.onNewChat(()         => this.newChat());
    window.api.onOpenSettings(()    => this.switchPanel('settings'));
    window.api.onModeSet((m)        => this.setMode(m));
    window.api.onAbout(()           => this.showAbout());
    window.api.onExportChat(()      => this.exportCurrentChat());
    window.api.onNewTerminal(()     => { this.switchPanel('terminal'); terminalManager.newTab(); });
    window.api.onZoom((dir) => {
      if (dir === 0) { document.body.style.zoom = '100%'; return; }
      const cur = parseFloat(document.body.style.zoom || '100') || 100;
      document.body.style.zoom = Math.min(200, Math.max(50, cur + dir * 10)) + '%';
    });
  }

  // ── Global keyboard shortcuts ─────────────────────────────────────────────
  _wireShortcuts() {
    this.shortcuts = [
      { keys: 'Ctrl+N',         desc: 'New chat',                action: () => this.newChat() },
      { keys: 'Ctrl+,',         desc: 'Open Settings',           action: () => this.switchPanel('settings') },
      { keys: 'Ctrl+M',         desc: 'Focus mode selector',     action: () => document.getElementById('mode-select')?.focus() },
      { keys: 'Ctrl+Shift+K',   desc: 'Clear conversation',      action: () => this._clearConversation() },
      { keys: 'Ctrl+E',         desc: 'Export chat',             action: () => this.exportCurrentChat() },
      { keys: 'Ctrl+Shift+T',   desc: 'New terminal tab',        action: () => { this.switchPanel('terminal'); terminalManager.newTab(); } },
      { keys: 'Ctrl+Space',     desc: 'Push-to-talk (hold)',     action: () => {} }, // handled in voice-engine
      { keys: 'Ctrl+?',         desc: 'Show keyboard shortcuts', action: () => this._showShortcutsPanel() },
      { keys: 'Ctrl+1',         desc: 'Mode: Chat',              action: () => this.setMode('general') },
      { keys: 'Ctrl+2',         desc: 'Mode: Terminal',          action: () => this.setMode('terminal') },
      { keys: 'Ctrl+3',         desc: 'Mode: Kali',              action: () => this.setMode('kali') },
      { keys: 'Ctrl+4',         desc: 'Mode: Red Team',          action: () => this.setMode('redteam') },
      { keys: 'Ctrl+5',         desc: 'Mode: Pure Intel',        action: () => this.setMode('pureintel') },
      { keys: 'Ctrl+6',         desc: 'Mode: Programming',       action: () => this.setMode('programming') },
      { keys: 'Escape',         desc: 'Close modal / stop TTS',  action: () => { this.closeModal(); voiceEngine.stopSpeaking(); } },
    ];

    document.addEventListener('keydown', (e) => {
      const ctrl  = e.ctrlKey;
      const shift = e.shiftKey;
      const key   = e.key;

      if (ctrl && !shift && key === 'n')        { e.preventDefault(); this.newChat(); }
      if (ctrl && !shift && key === ',')        { e.preventDefault(); this.switchPanel('settings'); }
      if (ctrl && !shift && key === 'm')        { e.preventDefault(); document.getElementById('mode-select')?.focus(); }
      if (ctrl && shift  && key === 'K')        { e.preventDefault(); this._clearConversation(); }
      if (ctrl && !shift && key === 'e')        { e.preventDefault(); this.exportCurrentChat(); }
      if (ctrl && !shift && key === '?')        { e.preventDefault(); this._showShortcutsPanel(); }
      if (ctrl && !shift && key === '1')        { e.preventDefault(); this.setMode('general'); }
      if (ctrl && !shift && key === '2')        { e.preventDefault(); this.setMode('terminal'); }
      if (ctrl && !shift && key === '3')        { e.preventDefault(); this.setMode('kali'); }
      if (ctrl && !shift && key === '4')        { e.preventDefault(); this.setMode('redteam'); }
      if (ctrl && !shift && key === '5')        { e.preventDefault(); this.setMode('pureintel'); }
      if (ctrl && !shift && key === '6')        { e.preventDefault(); this.setMode('programming'); }
      if (key === 'Escape') { this.closeModal(); voiceEngine.stopSpeaking(); }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PANEL SWITCHING
  // ══════════════════════════════════════════════════════════════════════════
  switchPanel(panelName) {
    this.activePanel = panelName;
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`${panelName}-panel`);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-panel="${panelName}"]`)?.classList.add('active');

    if (panelName === 'terminal') setTimeout(() => terminalManager.focusActive(), 60);
    if (panelName === 'settings') { settingsManager.reload(); voiceEngine.reloadSettings(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MODE
  // ══════════════════════════════════════════════════════════════════════════
  setMode(modeId) {
    if (!personaEngine.setMode(modeId)) return;
    const sel = document.getElementById('mode-select');
    if (sel) sel.value = modeId;
    this._updateStatus();
    window.api.settings.set('activeMode', modeId);
    this.toast(`Mode: ${modeId.toUpperCase()}`, 'info');
    // Sync sidebar mode buttons
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.classList.toggle('active-mode', b.dataset.mode === modeId);
    });
    // Update mode badge in chat header
    const badge = document.getElementById('mode-badge');
    if (badge) badge.textContent = modeId;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  CONVERSATION MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════
  async newChat() {
    this.messages     = [];
    this.activeConvId = null;
    this.streamBuffer = '';
    this.sessionTokens = 0;
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
    const title = document.getElementById('chat-conv-title');
    if (title) title.textContent = 'New Chat';
    const stok = document.getElementById('session-tokens');
    if (stok) stok.textContent = '0 session';
    document.querySelectorAll('.history-item').forEach(h => h.classList.remove('active'));
    document.getElementById('chat-input')?.focus();
  }

  async loadHistory() {
    const convs = await storageManager.getConversations(80);
    const list  = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';
    for (const c of convs) {
      const div = document.createElement('div');
      div.className   = 'history-item';
      div.dataset.id  = c.id;
      div.title       = `${c.title}\n${c.mode} · ${c.model}\n${c.updated_at}`;
      div.innerHTML   = `
        <span class="hi-title">${this._esc(c.title)}</span>
        <span class="hi-mode">${c.mode}</span>`;
      div.addEventListener('click', () => this.loadConversation(c.id));
      // Right-click to delete
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm(`Delete conversation: "${c.title}"?`)) {
          storageManager.deleteConversation(c.id).then(() => this.loadHistory());
          if (this.activeConvId === c.id) this.newChat();
        }
      });
      list.appendChild(div);
    }
  }

  async loadConversation(id) {
    const [msgs, conv] = await Promise.all([
      storageManager.getMessages(id),
      storageManager.getConversation(id)
    ]);
    this.activeConvId = id;
    this.messages     = msgs.map(m => ({ role: m.role, content: m.content }));

    document.querySelectorAll('.history-item').forEach(h => {
      h.classList.toggle('active', parseInt(h.dataset.id) === id);
    });

    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    for (const m of msgs) this._appendMessage(m.role, m.content, false);

    const title = document.getElementById('chat-conv-title');
    if (title) title.textContent = conv?.title || 'Chat';
    if (conv?.mode) this.setMode(conv.mode);

    container.scrollTop = container.scrollHeight;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SEND MESSAGE
  // ══════════════════════════════════════════════════════════════════════════
  async _handleSend() {
    const input = document.getElementById('chat-input');
    const text  = input?.value?.trim();
    if (!text || this.isStreaming) return;
    input.value = '';
    input.style.height = 'auto';
    await this.sendMessage(text);
  }

  async sendMessage(text) {
    if (!text || this.isStreaming) return;

    // ── Slash command routing ────────────────────────────────────────────
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(' ');
      const cmd   = parts[0].toLowerCase();
      const args  = parts.slice(1);

      // Built-in slash commands
      if (cmd === 'mode')   { if (args[0]) this.setMode(args[0]); return; }
      if (cmd === 'clear')  { this._clearConversation(); return; }
      if (cmd === 'new')    { this.newChat(); return; }
      if (cmd === 'help')   { this._showShortcutsPanel(); return; }
      if (cmd === 'bash') {
        const command = args.join(' ');
        if (command) {
          this.switchPanel('terminal');
          setTimeout(() => terminalManager.sendCommand(command), 200);
        }
        return;
      }
      if (cmd === 'export') { this.exportCurrentChat(); return; }

      // Plugin slash commands
      if (this.slashCommands.has(cmd)) {
        const fn  = this.slashCommands.get(cmd);
        const res = await fn(args);
        if (res) {
          // Display plugin response as AI message
          if (!this.activeConvId) {
            this.activeConvId = await storageManager.createConversation(`/${cmd}`, personaEngine.getMode());
            await this.loadHistory();
          }
          this._appendMessage('assistant', `**/${cmd}** → ${res}`, false);
          await storageManager.addMessage(this.activeConvId, 'assistant', res);
        }
        return;
      }
    }

    // ── Create conversation on first message ─────────────────────────────
    if (!this.activeConvId) {
      const title = text.slice(0, 52);
      const mode  = personaEngine.getMode();
      const model = settingsManager.get('ollamaModel') || 'tinyllama';
      this.activeConvId = await storageManager.createConversation(title, mode, model);
      await this.loadHistory();
    }

    // ── Store + display user message ─────────────────────────────────────
    this.messages.push({ role: 'user', content: text });
    await storageManager.addMessage(this.activeConvId, 'user', text, { mode: personaEngine.getMode() });
    this._appendMessage('user', text, false);

    // ── Start streaming ──────────────────────────────────────────────────
    this.isStreaming = true;
    this.streamBuffer = '';

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;

    // Show typing indicator
    const typingEl = this._showTyping();

    const msgBubble = this._appendMessage('assistant', '', true);

    try {
      await aiRouter.chat({
        messages:    this.messages,
        mode:        personaEngine.getMode(),
        extraContext: terminalManager.getActiveOutput()
                      ? `Recent terminal output:\n${terminalManager.getActiveOutput().slice(-800)}`
                      : '',
        onChunk: (chunk) => {
          typingEl?.remove();
          this.streamBuffer += chunk;
          msgBubble.innerHTML = this._renderMarkdown(this.streamBuffer);
          this._addCopyBtn(msgBubble.parentElement);
          const container = document.getElementById('chat-messages');
          if (container) container.scrollTop = container.scrollHeight;
        },
        onDone: async () => {
          msgBubble.classList.remove('streaming');
          typingEl?.remove();

          const final = this.streamBuffer;
          this.messages.push({ role: 'assistant', content: final });

          const model = settingsManager.get('routingMode') === 'cloud'
            ? (settingsManager.get('cloudModel') || 'cloud')
            : (settingsManager.get('ollamaModel') || 'tinyllama');

          await storageManager.addMessage(this.activeConvId, 'assistant', final, {
            mode:  personaEngine.getMode(),
            model,
            tokenCount: Math.ceil(final.length / 4)
          });

          // TTS
          voiceEngine.speak(final);

          // Token tracking
          const est = Math.ceil(final.length / 4);
          this.sessionTokens += est;
          this.totalTokens   += est;
          const stok = document.getElementById('session-tokens');
          if (stok) stok.textContent = `${this.sessionTokens} session`;
          this._updateStatus();

          // Add regenerate button
          this._addRegenBtn(msgBubble.parentElement);

          this.isStreaming = false;
          if (sendBtn) sendBtn.disabled = false;
          document.getElementById('chat-input')?.focus();
        },
        onError: (err) => {
          typingEl?.remove();
          msgBubble.classList.remove('streaming');
          msgBubble.innerHTML = `<span style="color:var(--red)">⚠ ${this._esc(String(err))}</span>`;
          this.isStreaming = false;
          if (sendBtn) sendBtn.disabled = false;
          this.toast(`AI error: ${String(err).slice(0, 80)}`, 'error');
        }
      });
    } catch (e) {
      typingEl?.remove();
      msgBubble.classList.remove('streaming');
      msgBubble.innerHTML = `<span style="color:var(--red)">⚠ ${this._esc(e.message)}</span>`;
      this.isStreaming = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  // ── Regenerate ────────────────────────────────────────────────────────────
  async _regenerate() {
    if (this.isStreaming) return;
    // Remove last assistant message, resend last user message
    const lastUser = [...this.messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return;
    // Pop last assistant message from array
    if (this.messages[this.messages.length - 1]?.role === 'assistant') {
      this.messages.pop();
    }
    // Remove last AI bubble from DOM
    const container = document.getElementById('chat-messages');
    const bubbles   = container?.querySelectorAll('.message.assistant');
    bubbles?.[bubbles.length - 1]?.remove();
    await this.sendMessage(lastUser.content);
  }

  // ── Clear conversation ────────────────────────────────────────────────────
  _clearConversation() {
    if (!confirm('Clear this conversation? History is kept in the sidebar.')) return;
    this.messages     = [];
    this.streamBuffer = '';
    const container   = document.getElementById('chat-messages');
    if (container) container.innerHTML = '';
    this.toast('Conversation cleared.', 'info');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MESSAGE RENDERING
  // ══════════════════════════════════════════════════════════════════════════
  _appendMessage(role, content, streaming) {
    const container = document.getElementById('chat-messages');
    if (!container) return null;

    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? '👤' : '⬡';

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble${streaming ? ' streaming' : ''}`;
    if (content) bubble.innerHTML = this._renderMarkdown(content);

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrapper.appendChild(avatar);
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'msg-body';
    bodyWrap.appendChild(bubble);
    bodyWrap.appendChild(meta);
    wrapper.appendChild(bodyWrap);

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  _showTyping() {
    const container = document.getElementById('chat-messages');
    if (!container) return null;
    const div = document.createElement('div');
    div.className = 'message assistant typing-indicator-wrap';
    div.innerHTML = `
      <div class="msg-avatar">⬡</div>
      <div class="msg-body">
        <div class="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  _addCopyBtn(wrapper) {
    if (!wrapper || wrapper.querySelector('.msg-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className   = 'msg-copy-btn';
    btn.title       = 'Copy message';
    btn.textContent = '⎘';
    btn.addEventListener('click', () => {
      const text = wrapper.querySelector('.msg-bubble')?.innerText || '';
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⎘'; }, 1500);
      });
    });
    const meta = wrapper.querySelector('.msg-meta');
    if (meta) meta.appendChild(btn);
  }

  _addRegenBtn(wrapper) {
    if (!wrapper || wrapper.querySelector('.msg-regen-btn')) return;
    const btn = document.createElement('button');
    btn.className   = 'msg-regen-btn';
    btn.title       = 'Regenerate response';
    btn.textContent = '↺';
    btn.addEventListener('click', () => this._regenerate());
    const meta = wrapper.querySelector('.msg-meta');
    if (meta) meta.appendChild(btn);
  }

  _renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
      try {
        return marked.parse(text, { breaks: true, gfm: true });
      } catch (_) {}
    }
    // Minimal fallback
    return this._esc(text).replace(/\n/g, '<br>');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  STATUS BAR
  // ══════════════════════════════════════════════════════════════════════════
  _updateStatus() {
    const mode    = personaEngine.getMode().toUpperCase();
    const model   = settingsManager.get('ollamaModel') || 'tinyllama';
    const routing = settingsManager.get('routingMode')  || 'local';
    const backend = routing === 'cloud' ? '☁ cloud' : routing === 'auto' ? '⚡ auto' : '🏠 local';

    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('status-mode',           mode);
    s('status-model',          model);
    s('status-backend',        backend);
    s('status-tokens',         `${this.totalTokens} tok`);
    s('chat-mode-badge',       mode);
    s('chat-model-badge',      model);
    s('sidebar-model-label',   model);
    s('sidebar-backend-label', backend);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  HEALTH CHECK
  // ══════════════════════════════════════════════════════════════════════════
  async _checkOllamaHealth() {
    const dot    = document.getElementById('ai-status-dot');
    const result = await aiRouter.testOllama();
    if (dot) dot.style.background = result.ok ? '#22c55e' : '#ef4444';
    if (!result.ok) {
      this.toast('Ollama not reachable. Start Ollama: ollama serve', 'warning');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FIRST-RUN WIZARD
  // ══════════════════════════════════════════════════════════════════════════
  _showFirstRunWizard() {
    this.openModal('Welcome to John Modica AI', `
      <div style="text-align:center;padding:8px 0 16px;">
        <div style="font-size:48px;margin-bottom:12px;">⬡</div>
        <h2 style="color:var(--text-accent);margin-bottom:8px;">Welcome, John.</h2>
        <p style="color:var(--text-2);margin-bottom:20px;line-height:1.7;">
          Your AI shell is ready. Here's what to check first:
        </p>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;">
        <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;">
          <strong style="color:var(--green);">1. Ollama running?</strong><br>
          <span style="color:var(--text-2);">Open a terminal and run: <code style="color:var(--purple-main)">ollama serve</code></span>
        </div>
        <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;">
          <strong style="color:var(--green);">2. Model pulled?</strong><br>
          <span style="color:var(--text-2);">Run: <code style="color:var(--purple-main)">ollama pull tinyllama</code></span>
        </div>
        <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;">
          <strong style="color:var(--green);">3. Cloud AI? (optional)</strong><br>
          <span style="color:var(--text-2);">Add your API key in <strong>Settings → AI</strong></span>
        </div>
        <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;">
          <strong style="color:var(--green);">4. Voice?</strong><br>
          <span style="color:var(--text-2);">Enable in <strong>Settings → Voice</strong>. Push-to-talk: <code style="color:var(--purple-main)">Ctrl+Space</code></span>
        </div>
      </div>
      <div style="text-align:center;margin-top:20px;">
        <button onclick="document.getElementById('modal-overlay').classList.remove('open')"
          style="background:var(--purple-mid);border:none;color:#fff;padding:10px 28px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700;">
          Let's go ⬡
        </button>
      </div>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SHORTCUTS PANEL
  // ══════════════════════════════════════════════════════════════════════════
  _showShortcutsPanel() {
    const rows = this.shortcuts.map(s =>
      `<tr>
        <td><kbd style="background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-family:var(--font-mono);font-size:12px;">${s.keys}</kbd></td>
        <td style="padding-left:16px;color:var(--text-2);font-size:13px;">${s.desc}</td>
      </tr>`
    ).join('');
    this.openModal('⌨ Keyboard Shortcuts', `
      <table style="width:100%;border-collapse:separate;border-spacing:0 6px;">
        ${rows}
      </table>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  EXPORT
  // ══════════════════════════════════════════════════════════════════════════
  async exportCurrentChat() {
    if (!this.activeConvId) { this.toast('No active conversation to export.', 'warning'); return; }
    const md   = await storageManager.exportConversationMarkdown(this.activeConvId);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `modica-chat-${this.activeConvId}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Chat exported as Markdown.', 'success');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TOAST NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════
  toast(msg, type = 'info', duration = 4000) {
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${this._esc(msg)}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
  }

  toastWithAction(msg, actionLabel, actionFn, duration = 8000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'toast info';
    t.innerHTML = `
      <span class="toast-icon">ℹ</span>
      <span style="flex:1;">${this._esc(msg)}</span>
      <button style="background:var(--purple-fade);border:1px solid var(--purple-dim);color:var(--purple-glow);
        border-radius:4px;padding:2px 10px;cursor:pointer;font-size:11px;white-space:nowrap;">
        ${this._esc(actionLabel)}
      </button>`;
    t.querySelector('button').addEventListener('click', () => { actionFn(); t.remove(); });
    container.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MODAL
  // ══════════════════════════════════════════════════════════════════════════
  openModal(title, html) {
    const overlay = document.getElementById('modal-overlay');
    const titleEl = document.getElementById('modal-title');
    const bodyEl  = document.getElementById('modal-body');
    if (!overlay || !titleEl || !bodyEl) return;
    titleEl.textContent = title;
    bodyEl.innerHTML    = html;
    overlay.classList.add('open');
  }

  closeModal() {
    document.getElementById('modal-overlay')?.classList.remove('open');
  }

  // ── About dialog ──────────────────────────────────────────────────────────
  showAbout() {
    const info = this.appInfo || {};
    const stats = { convs: 0, msgs: 0 };
    storageManager.getStats().then(s => {
      document.getElementById('about-convs').textContent  = s.conversations;
      document.getElementById('about-msgs').textContent   = s.messages;
      document.getElementById('about-tokens').textContent = s.totalTokens;
    });
    this.openModal('About John Modica AI', `
      <div style="text-align:center;padding:8px 0 12px;">
        <div style="font-size:44px;margin-bottom:10px;filter:drop-shadow(0 0 12px #9b59b6);">⬡</div>
        <h2 style="color:var(--text-accent);margin-bottom:2px;">John Modica AI Shell</h2>
        <p style="color:var(--text-3);font-size:12px;margin-bottom:16px;">v2.0 · Electron Edition · Built for John</p>
        <hr style="border-color:var(--border);margin:0 0 16px;">
        <table style="width:100%;font-size:12px;text-align:left;border-spacing:0 4px;">
          <tr><td style="color:var(--text-3);padding:3px 8px;">Platform</td><td>${info.platform || '?'} ${info.arch || ''}</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Shell</td><td>${info.shell || '?'}</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Data dir</td><td style="font-size:11px;font-family:monospace;word-break:break-all;">${info.dataDir || '?'}</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Persona</td><td>${personaEngine.getPersonaInfo().promptChars} chars</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Modes</td><td>${personaEngine.getModeIds().length} operational modes</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Conversations</td><td id="about-convs">…</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Messages</td><td id="about-msgs">…</td></tr>
          <tr><td style="color:var(--text-3);padding:3px 8px;">Total tokens</td><td id="about-tokens">…</td></tr>
        </table>
      </div>
    `);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════════════════════════════
  _esc(str) {
    return String(str ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

// ─── Global error handling ────────────────────────────────────────────────────
window.onerror = (msg, src, line, col, err) => {
  console.error('[MODICA] Uncaught error:', msg, `${src}:${line}:${col}`);
  // Send to main for logging (fire and forget)
  try { window.api.fs.write('/dev/null', '').catch(() => {}); } catch (_) {}
};

window.addEventListener('unhandledrejection', (e) => {
  console.error('[MODICA] Unhandled promise rejection:', e.reason);
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const appController = new AppController();
window.appController = appController;

document.addEventListener('DOMContentLoaded', () => {
  appController.boot();
});
