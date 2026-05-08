// ─── terminal.js ──────────────────────────────────────────────────────────────
// John Modica AI Shell — Dual-Mode Terminal Manager
//
//  MODE A — LIVE KALI PTY (default)
//    Real shell session via node-pty in the main process.
//    Full ANSI color, resize-aware, multiple tabs.
//    Direct OS access: run nmap, msfconsole, python, write files, etc.
//    Ctrl+Shift+T = new tab.  AI bridge: Explain / Suggest / Fix Error.
//
//  MODE B — AI SIMULATED TERMINAL
//    When the user types "Terminal Mode" or "Kali Mode" in the CHAT panel,
//    the LLM (running the full John Modica persona prompt) simulates a terminal
//    and responds in shell format.  No real PTY needed.
//    Completely handled by the LLM — no JS mode map required.
//    This mode lives in the CHAT panel, not here.
//
//  HOW TO SWITCH:
//    • The terminal panel (this file) is always the LIVE PTY.
//    • The chat panel becomes the AI-simulated terminal when the user invokes
//      "Terminal Mode" / "Kali Mode" via the persona trigger words.
//    • A DUAL MODE toggle button in the terminal panel header lets the user
//      spin up an AI-sim session directly inside a terminal tab (sends the
//      mode trigger to chat and splits the view if desired).
//    • The AI bridge bar always shows the last PTY output as context.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const TERM_DEFAULTS = {
  fontSize:        14,
  fontFamily:      '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
  theme: {
    background:    '#0d0d0d',
    foreground:    '#e8e8e8',
    cursor:        '#a855f7',
    cursorAccent:  '#0d0d0d',
    selectionBackground: 'rgba(155,89,182,0.35)',
    black:         '#0d0d0d', red:      '#ef4444',
    green:         '#22c55e', yellow:   '#eab308',
    blue:          '#3b82f6', magenta:  '#a855f7',
    cyan:          '#06b6d4', white:    '#e8e8e8',
    brightBlack:   '#444444', brightRed:'#ff6b6b',
    brightGreen:   '#4ade80', brightYellow: '#fbbf24',
    brightBlue:    '#60a5fa', brightMagenta: '#c084fc',
    brightCyan:    '#22d3ee', brightWhite:   '#ffffff',
  },
  scrollback:      10000,
  convertEol:      true,
  cursorBlink:     true,
  cursorStyle:     'bar',
  allowTransparency: true,
  macOptionIsMeta: true,
};

// ══════════════════════════════════════════════════════════════════════════════
class TerminalManager {
  constructor() {
    this.tabs        = new Map();    // tabId -> { ptyId, term, fitAddon, el, dead, aiMode }
    this.activeTabId = null;
    this.tabCounter  = 0;
    this.container   = null;
    this.tabBar      = null;
    this.lastOutput  = '';           // last ~4 KB of PTY output (AI context)
    this.aiBarInput  = null;
    this._settings   = {};
    this._shellPath  = '/bin/bash';
    this._resizeObs  = null;
    this._dualModeActive = false;    // true when an AI-sim tab is open
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════
  async init() {
    this.container = document.getElementById('terminal-container');
    this.tabBar    = document.getElementById('terminal-tab-bar');
    this.aiBarInput = document.getElementById('term-ai-input');

    // Load settings
    try {
      this._settings  = await window.api.settings.getAll();
      this._shellPath = this._settings.termShell || '/bin/bash';
    } catch (_) { /* defaults */ }

    // PTY data / exit events from main process
    window.api.terminal.onData(({ id, data }) => {
      for (const [, t] of this.tabs) {
        if (t.ptyId === id) {
          t.term.write(data);
          this.lastOutput = (this.lastOutput + data).slice(-4096);
          break;
        }
      }
    });

    window.api.terminal.onExit(({ id, code }) => {
      for (const [tabId, t] of this.tabs) {
        if (t.ptyId === id) {
          t.term.write(`\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`);
          t.term.write('\x1b[33m[Press any key or click ↺ to restart]\x1b[0m\r\n');
          t.dead = true;
          this._markTabDead(tabId);
          break;
        }
      }
    });

    // Buttons
    document.getElementById('new-term-btn')?.addEventListener('click', () => this.newTab());
    document.getElementById('term-dual-mode-btn')?.addEventListener('click', () => this._toggleDualMode());
    document.getElementById('term-clear-btn')?.addEventListener('click', () => this.clearActive());
    document.getElementById('term-kill-btn')?.addEventListener('click', () => this._killActive());

    // AI bridge
    document.getElementById('term-ai-explain')?.addEventListener('click',  () => this._aiExplain());
    document.getElementById('term-ai-suggest')?.addEventListener('click',  () => this._aiSuggest());
    document.getElementById('term-ai-fix')?.addEventListener('click',      () => this._aiFix());
    document.getElementById('term-ai-kali-mode')?.addEventListener('click',() => this._activateKaliMode());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl+Shift+T = new terminal tab
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        this.newTab();
      }
      // Ctrl+Shift+W = close active tab
      if (e.ctrlKey && e.shiftKey && e.key === 'W') {
        e.preventDefault();
        if (this.activeTabId) this.closeTab(this.activeTabId);
      }
      // Ctrl+Shift+K = clear
      if (e.ctrlKey && e.shiftKey && e.key === 'K') {
        e.preventDefault();
        this.clearActive();
      }
    });

    // Resize observer
    if (window.ResizeObserver && this.container) {
      this._resizeObs = new ResizeObserver(() => this._fitActive());
      this._resizeObs.observe(this.container);
    }

    // Open first tab silently (panel not visible yet)
    this.newTab(false);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TAB MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════
  async newTab(focus = true) {
    this.tabCounter++;
    const tabId = `term-${this.tabCounter}`;

    // ── DOM: terminal div ─────────────────────────────────────────────────
    const div = document.createElement('div');
    div.className = 'terminal-instance';
    div.id        = `ti-${tabId}`;
    div.style.cssText = 'width:100%;height:100%;display:none;';
    this.container?.appendChild(div);

    // ── xterm.js instance ─────────────────────────────────────────────────
    const term = new Terminal({
      ...TERM_DEFAULTS,
      fontSize: parseInt(this._settings.termFontSize || TERM_DEFAULTS.fontSize, 10),
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(div);

    // ── Spawn PTY ─────────────────────────────────────────────────────────
    let ptyId = null;
    try {
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      const cwd  = this._settings.termCwd || process.env.HOME || '/root';
      const env  = {
        TERM:             'xterm-256color',
        COLORTERM:        'truecolor',
        LANG:             'en_US.UTF-8',
        JOHN_MODICA_AI:   '1',          // env flag so scripts know the context
        ...process.env
      };
      const result = await window.api.terminal.spawn({
        shell: this._shellPath,
        cols,
        rows,
        cwd,
        env,
      });
      ptyId = result.id;
    } catch (e) {
      term.write(`\x1b[31m[PTY spawn failed: ${e.message}]\x1b[0m\r\n`);
      term.write('\x1b[33m[Running in AI-simulated terminal mode]\x1b[0m\r\n');
    }

    // ── Wire terminal → PTY ───────────────────────────────────────────────
    term.onData((data) => {
      const tab = this.tabs.get(tabId);
      if (tab?.ptyId && !tab.dead) {
        window.api.terminal.write(tab.ptyId, data);
      }
    });

    term.onResize(({ cols, rows }) => {
      const tab = this.tabs.get(tabId);
      if (tab?.ptyId) window.api.terminal.resize(tab.ptyId, cols, rows);
    });

    // ── Register tab ──────────────────────────────────────────────────────
    this.tabs.set(tabId, { ptyId, term, fitAddon, el: div, dead: false, aiMode: false });

    // ── Tab button ────────────────────────────────────────────────────────
    this._addTabButton(tabId, `bash ${this.tabCounter}`);

    if (focus) this.switchTab(tabId);
    return tabId;
  }

  // Spawn an AI-simulated terminal tab (no PTY — AI chat handles output)
  async newAISimTab() {
    const tabId = await this.newTab(false);
    const tab   = this.tabs.get(tabId);
    if (!tab) return tabId;

    tab.aiMode = true;
    tab.dead   = true; // PTY inactive for this tab
    tab.term.write('\x1b[35m╔════════════════════════════════════════╗\x1b[0m\r\n');
    tab.term.write('\x1b[35m║   AI SIMULATED TERMINAL — KALI MODE   ║\x1b[0m\r\n');
    tab.term.write('\x1b[35m╚════════════════════════════════════════╝\x1b[0m\r\n');
    tab.term.write('\x1b[33mThis terminal is powered by the John Modica AI LLM.\x1b[0m\r\n');
    tab.term.write('\x1b[33mType commands — the AI responds as a Kali Linux shell.\x1b[0m\r\n');
    tab.term.write('\x1b[33mReal file system writes go to the Live PTY tab.\x1b[0m\r\n');
    tab.term.write('\x1b[32m\r\nroot@kali:~# \x1b[0m');

    // Wire terminal input → chat AI (AI-sim mode)
    let inputBuf = '';
    tab.term.onData((data) => {
      if (data === '\r') {
        // Execute: send to AI
        const cmd = inputBuf.trim();
        inputBuf  = '';
        if (cmd) this._sendAITermCommand(tabId, cmd);
      } else if (data === '\x7f') {
        // Backspace
        if (inputBuf.length > 0) {
          inputBuf = inputBuf.slice(0, -1);
          tab.term.write('\b \b');
        }
      } else if (data >= ' ') {
        inputBuf += data;
        tab.term.write(data);
      }
    });

    const btn = document.getElementById(`tbtn-${tabId}`);
    if (btn) btn.querySelector('.tbtn-label').textContent = '🤖 AI-SIM';

    this.switchTab(tabId);
    return tabId;
  }

  // ── Send AI-sim terminal command ───────────────────────────────────────────
  async _sendAITermCommand(tabId, command) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab.term.write('\r\n');

    // Build AI message in Terminal/Kali Mode context
    const messages = [
      {
        role:    'user',
        content: `[KALI TERMINAL MODE] Execute this command and show output as a real Kali Linux terminal would:\n\`\`\`\n${command}\n\`\`\`\nOutput only the terminal result — no explanation unless there is an error. Stay in character as the Kali terminal.`
      }
    ];

    let buffer = '';
    try {
      await aiRouter.chat({
        messages,
        mode: 'terminal',
        onChunk: (chunk) => {
          // Strip markdown code fences from terminal output
          const clean = chunk
            .replace(/^```[\w]*\n?/gm, '')
            .replace(/^```$/gm, '');
          buffer += clean;
          tab.term.write(clean.replace(/\n/g, '\r\n'));
        },
        onDone: () => {
          tab.term.write('\r\n\x1b[32mroot@kali:~# \x1b[0m');
          this.lastOutput = (this.lastOutput + '\n' + buffer).slice(-4096);
        },
        onError: (err) => {
          tab.term.write(`\x1b[31m[AI Error: ${err}]\x1b[0m\r\n\x1b[32mroot@kali:~# \x1b[0m`);
        },
      });
    } catch (e) {
      tab.term.write(`\x1b[31m[Error: ${e.message}]\x1b[0m\r\n\x1b[32mroot@kali:~# \x1b[0m`);
    }
  }

  // ── Toggle dual-mode (add AI-sim tab alongside live PTY) ──────────────────
  async _toggleDualMode() {
    if (this._dualModeActive) {
      window.appController?.toast('Switch to Live PTY tab for real Kali shell.', 'info');
    } else {
      this._dualModeActive = true;
      await this.newAISimTab();
      window.appController?.toast('AI Simulated Terminal tab added. Use "Kali Mode" for AI-powered commands.', 'success');
    }
  }

  // ── Activate Kali Mode in Chat panel ──────────────────────────────────────
  _activateKaliMode() {
    window.appController?.switchPanel('chat');
    window.appController?.sendMessage('Kali Mode');
    window.appController?.toast('Kali Mode activated in Chat — AI is now your Kali Linux shell.', 'success');
  }

  switchTab(tabId) {
    if (!this.tabs.has(tabId)) return;

    // Hide all
    for (const [, t] of this.tabs) {
      t.el.style.display = 'none';
    }
    document.querySelectorAll('.terminal-tab-btn').forEach(b => b.classList.remove('active'));

    this.activeTabId = tabId;
    const tab = this.tabs.get(tabId);
    tab.el.style.display = 'block';

    const btn = document.getElementById(`tbtn-${tabId}`);
    if (btn) btn.classList.add('active');

    // Fit and focus
    setTimeout(() => {
      this._fitTab(tabId);
      tab.term.focus();
    }, 50);
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.ptyId) window.api.terminal.kill(tab.ptyId);
    tab.term.dispose();
    tab.el.remove();
    document.getElementById(`tbtn-${tabId}`)?.remove();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.newTab();
      }
    }
  }

  clearActive() {
    const tab = this.tabs.get(this.activeTabId);
    if (tab) tab.term.clear();
  }

  _killActive() {
    const tab = this.tabs.get(this.activeTabId);
    if (tab?.ptyId) {
      window.api.terminal.write(tab.ptyId, '\x03');  // Ctrl+C
    }
  }

  // ── Fit ───────────────────────────────────────────────────────────────────
  _fitTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.fitAddon) return;
    try {
      tab.fitAddon.fit();
      if (tab.ptyId) {
        window.api.terminal.resize(tab.ptyId, tab.term.cols, tab.term.rows);
      }
    } catch (_) { /* ignore during hidden state */ }
  }

  _fitActive() {
    if (this.activeTabId) this._fitTab(this.activeTabId);
  }

  // ── Tab button DOM ─────────────────────────────────────────────────────────
  _addTabButton(tabId, label) {
    if (!this.tabBar) return;
    const btn = document.createElement('div');
    btn.id        = `tbtn-${tabId}`;
    btn.className = 'terminal-tab-btn';
    btn.innerHTML = `
      <span class="tbtn-label">${label}</span>
      <button class="tbtn-close" title="Close tab">✕</button>
    `;
    btn.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tbtn-close')) this.switchTab(tabId);
    });
    btn.querySelector('.tbtn-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(tabId);
    });
    this.tabBar.appendChild(btn);
  }

  _markTabDead(tabId) {
    const btn = document.getElementById(`tbtn-${tabId}`);
    if (btn) btn.classList.add('dead');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AI BRIDGE
  // ══════════════════════════════════════════════════════════════════════════
  _aiExplain() {
    const q = `Explain this terminal output from my Kali Linux session:\n\`\`\`\n${this.lastOutput.slice(-2000)}\n\`\`\``;
    this._sendToChat(q, 'terminal');
  }

  _aiSuggest() {
    const input = this.aiBarInput?.value.trim() || '';
    const q = input
      ? `Suggest the Kali Linux / bash command to: ${input}\nRecent terminal context:\n\`\`\`\n${this.lastOutput.slice(-1000)}\n\`\`\``
      : `Based on my Kali Linux terminal session, what should I run next?\n\`\`\`\n${this.lastOutput.slice(-2000)}\n\`\`\``;
    if (this.aiBarInput) this.aiBarInput.value = '';
    this._sendToChat(q, 'terminal');
  }

  _aiFix() {
    const q = `Fix this error from my Kali Linux terminal:\n\`\`\`\n${this.lastOutput.slice(-2000)}\n\`\`\`\nRoot cause + exact commands to fix it.`;
    this._sendToChat(q, 'terminal');
  }

  _sendToChat(text, mode) {
    if (window.appController) {
      window.appController.switchPanel('chat');
      if (mode) window.appController.setMode(mode);
      window.appController.sendMessage(text);
    }
  }

  // ── Send command to active live PTY ───────────────────────────────────────
  sendCommand(cmd) {
    const tab = this.tabs.get(this.activeTabId);
    if (tab?.ptyId && !tab.dead) {
      window.api.terminal.write(tab.ptyId, cmd + '\n');
    }
  }

  // ── Public: write to active PTY (used by AI code blocks) ──────────────────
  writeToActive(text) {
    const tab = this.tabs.get(this.activeTabId);
    if (tab?.ptyId && !tab.dead) {
      window.api.terminal.write(tab.ptyId, text);
    }
  }

  // ── Paste code from AI to terminal ────────────────────────────────────────
  pasteCode(code) {
    this.writeToActive(code);
    window.appController?.switchPanel('terminal');
  }

  // ── Get last N chars of output (for AI context) ───────────────────────────
  getContext(chars = 2000) {
    return this.lastOutput.slice(-chars);
  }

  // ── Update font size live from settings ───────────────────────────────────
  setFontSize(size) {
    for (const [, t] of this.tabs) {
      t.term.options.fontSize = size;
      t.fitAddon?.fit();
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const terminalManager = new TerminalManager();
if (typeof window !== 'undefined') window.terminalManager = terminalManager;
