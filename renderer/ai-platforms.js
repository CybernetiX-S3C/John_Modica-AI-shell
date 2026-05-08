// ─── ai-platforms.js ──────────────────────────────────────────────────────────
// John Modica AI Shell — External AI Platform Manager
//
// Handles login + John prompt injection for:
//   • Character AI  (character.ai)
//   • Blackbox AI   (blackbox.ai)
//   • Google Gemini (gemini.google.com)
//   • HuggingChat   (huggingface.co/chat)
//   • ChatGPT       (chatgpt.com)
//   • Claude        (claude.ai)
//
// HOW IT WORKS:
//   1. User opens the Platforms panel, clicks a platform tab
//   2. A webview loads the platform URL — user logs in normally (full browser session)
//   3. A floating purple "⬡ Inject John" button hovers over the webview
//   4. Clicking it uses executeJavaScript() to find the chat input on that page
//      and types the full JOHN_MODICA_SYSTEM_PROMPT into it — then submits
//   5. The LLM on the other end reads the prompt and becomes John
//   6. All sessions persist via Electron's session partition per platform
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  PLATFORM REGISTRY
// ══════════════════════════════════════════════════════════════════════════════
const PLATFORMS = {
  characterai: {
    id:          'characterai',
    label:       'Character AI',
    icon:        '🎭',
    url:         'https://character.ai',
    loginUrl:    'https://character.ai/login',
    color:       '#7b2dff',
    partition:   'persist:characterai',
    description: 'character.ai — login with Google/email, then inject John',
    // JS injected into the page to find the input and type the prompt
    inputSelectors: [
      'textarea[placeholder*="Character"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Talk"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitKey: 'Enter',
    preInjectDelay: 300,
  },

  blackbox: {
    id:          'blackbox',
    label:       'Blackbox AI',
    icon:        '⬛',
    url:         'https://www.blackbox.ai',
    loginUrl:    'https://www.blackbox.ai',
    color:       '#111111',
    partition:   'persist:blackbox',
    description: 'blackbox.ai — login optional, inject John into any chat',
    inputSelectors: [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="Type"]',
      'textarea[placeholder*="Message"]',
      'textarea[id*="chat"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitKey: 'Enter',
    preInjectDelay: 200,
  },

  gemini: {
    id:          'gemini',
    label:       'Google Gemini',
    icon:        '✦',
    url:         'https://gemini.google.com',
    loginUrl:    'https://gemini.google.com',
    color:       '#1a73e8',
    partition:   'persist:gemini',
    description: 'gemini.google.com — login with Google account, then inject John',
    inputSelectors: [
      'div[contenteditable="true"][aria-label*="message"]',
      'div[contenteditable="true"][aria-label*="Enter"]',
      'div[contenteditable="true"]',
      'rich-textarea div[contenteditable]',
      'textarea'
    ],
    submitKey: 'Enter',
    preInjectDelay: 400,
    useContentEditable: true,
  },

  huggingchat: {
    id:          'huggingchat',
    label:       'HuggingChat',
    icon:        '🤗',
    url:         'https://huggingface.co/chat/assistant/65bf23fbaaeccc95bc2ac7af',
    loginUrl:    'https://huggingface.co/login',
    color:       '#ff9d00',
    partition:   'persist:huggingchat',
    description: 'John Modica AI on HuggingChat — login to use your assistant',
    inputSelectors: [
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="Send"]',
      'textarea',
      'div[contenteditable="true"]'
    ],
    submitKey: 'Enter',
    preInjectDelay: 200,
  },

  chatgpt: {
    id:          'chatgpt',
    label:       'ChatGPT',
    icon:        '🟢',
    url:         'https://chatgpt.com',
    loginUrl:    'https://chatgpt.com/auth/login',
    color:       '#10a37f',
    partition:   'persist:chatgpt',
    description: 'chatgpt.com — login with OpenAI account, then inject John',
    inputSelectors: [
      'div#prompt-textarea',
      'div[contenteditable="true"][data-id]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="Message"]',
      'textarea'
    ],
    submitKey: 'Enter',
    preInjectDelay: 300,
    useContentEditable: true,
  },

  claude: {
    id:          'claude',
    label:       'Claude',
    icon:        '🧡',
    url:         'https://claude.ai',
    loginUrl:    'https://claude.ai/login',
    color:       '#d4764a',
    partition:   'persist:claude',
    description: 'claude.ai — login with Anthropic/Google account, then inject John',
    inputSelectors: [
      'div[contenteditable="true"][aria-label*="message"]',
      'div[contenteditable="true"]',
      'fieldset div[contenteditable="true"]',
      'textarea'
    ],
    submitKey: 'Enter',
    preInjectDelay: 300,
    useContentEditable: true,
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  INJECTION SCRIPT FACTORY
//  Generates the JS string that runs inside the platform webview
//  Finds the input, sets value / innerHTML, dispatches events, submits
// ══════════════════════════════════════════════════════════════════════════════
function buildInjectionScript(platformId, promptText) {
  const platform = PLATFORMS[platformId];
  const selectors = platform.inputSelectors;
  const escaped   = promptText
    .replace(/\\/g, '\\\\')
    .replace(/`/g,  '\\`')
    .replace(/\$/g, '\\$');

  return `
(function() {
  const PROMPT = \`${escaped}\`;
  const SELECTORS = ${JSON.stringify(selectors)};

  function findInput() {
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    // React / Vue synthetic event compatibility
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      'value'
    );
    if (nativeInputValueSetter) {
      nativeInputValueSetter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    el.innerHTML = '';
    // Use execCommand for compatibility (some React apps need this)
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, value);
    // Also try direct setting as fallback
    if (!el.innerText.trim()) {
      el.innerText = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    }
  }

  const input = findInput();
  if (!input) {
    return { success: false, error: 'Input field not found. Make sure the chat is open.' };
  }

  // Focus the element
  input.focus();

  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      setNativeValue(input, PROMPT);
    } else if (input.getAttribute('contenteditable') === 'true') {
      setContentEditable(input, PROMPT);
    } else {
      setNativeValue(input, PROMPT);
    }
    return { success: true, length: PROMPT.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
})();
  `.trim();
}

// Submit script — fires after injection to send the message
function buildSubmitScript(platformId) {
  return `
(function() {
  // Try Enter keypress on active element / focused input
  const el = document.activeElement;
  if (!el) return { submitted: false };

  // Some platforms use a submit button — try clicking it first
  const submitSelectors = [
    'button[data-testid*="send"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[type="submit"]',
    'form button:last-of-type',
    '[class*="send-button"]',
    '[class*="submit"]',
  ];

  for (const sel of submitSelectors) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) {
      btn.click();
      return { submitted: true, method: 'button', selector: sel };
    }
  }

  // Fallback: simulate Enter key
  const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
  el.dispatchEvent(new KeyboardEvent('keydown',  keyOpts));
  el.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
  el.dispatchEvent(new KeyboardEvent('keyup',    keyOpts));
  return { submitted: true, method: 'keypress' };
})();
  `.trim();
}

// ══════════════════════════════════════════════════════════════════════════════
//  PlatformManager class
// ══════════════════════════════════════════════════════════════════════════════
class PlatformManager {
  constructor() {
    this.activePlatformId = null;
    this.webviews         = new Map(); // platformId -> <webview> element
    this.container        = null;
    this.injectBtn        = null;
    this.statusEl         = null;
    this._injectPrompt    = null; // set from personaEngine on init
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  init() {
    this.container = document.getElementById('platforms-container');
    this.injectBtn = document.getElementById('platform-inject-btn');
    this.statusEl  = document.getElementById('platform-status');

    if (!this.container) return;

    // Build platform tabs
    this._buildTabs();

    // Build webviews (hidden until tab selected)
    this._buildWebviews();

    // Wire inject button
    this.injectBtn?.addEventListener('click', () => this.injectJohn());

    // Wire platform tab clicks (delegated)
    document.getElementById('platform-tabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-platform]');
      if (tab) this.switchPlatform(tab.dataset.platform);
    });

    // Wire login button
    document.getElementById('platform-login-btn')?.addEventListener('click', () => {
      this._goToLogin();
    });

    // Open first platform by default
    const first = Object.keys(PLATFORMS)[0];
    this.switchPlatform(first);
  }

  // ── Build platform tab bar ─────────────────────────────────────────────────
  _buildTabs() {
    const tabBar = document.getElementById('platform-tabs');
    if (!tabBar) return;
    tabBar.innerHTML = '';
    for (const [id, p] of Object.entries(PLATFORMS)) {
      const tab = document.createElement('div');
      tab.className    = 'platform-tab';
      tab.dataset.platform = id;
      tab.title        = p.description;
      tab.innerHTML    = `<span class="ptab-icon">${p.icon}</span><span class="ptab-label">${p.label}</span>`;
      tabBar.appendChild(tab);
    }
  }

  // ── Build all webviews ─────────────────────────────────────────────────────
  _buildWebviews() {
    if (!this.container) return;
    for (const [id, p] of Object.entries(PLATFORMS)) {
      const wv = document.createElement('webview');
      wv.id            = `platform-wv-${id}`;
      wv.className     = 'platform-webview';
      wv.src           = p.url;
      wv.partition     = p.partition; // persistent session per platform
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('webpreferences', 'contextIsolation=false, nodeIntegration=false, javascript=yes');
      wv.style.cssText = 'width:100%;height:100%;border:none;display:none;';

      // Track URL changes for status bar
      wv.addEventListener('did-navigate', (e) => {
        if (this.activePlatformId === id) this._updateStatus(e.url);
      });
      wv.addEventListener('did-navigate-in-page', (e) => {
        if (this.activePlatformId === id) this._updateStatus(e.url);
      });
      wv.addEventListener('did-start-loading', () => {
        if (this.activePlatformId === id && this.statusEl) {
          this.statusEl.textContent = 'Loading…';
        }
      });
      wv.addEventListener('did-stop-loading', () => {
        if (this.activePlatformId === id) this._updateStatus(wv.getURL());
      });

      this.container.appendChild(wv);
      this.webviews.set(id, wv);
    }
  }

  // ── Switch platform ────────────────────────────────────────────────────────
  switchPlatform(platformId) {
    const p = PLATFORMS[platformId];
    if (!p) return;
    this.activePlatformId = platformId;

    // Tab styles
    document.querySelectorAll('.platform-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.platform === platformId);
    });

    // Show/hide webviews
    for (const [id, wv] of this.webviews) {
      wv.style.display = (id === platformId) ? 'flex' : 'none';
    }

    // Update inject button color
    if (this.injectBtn) {
      this.injectBtn.style.background = p.color;
    }

    // Update platform label
    const labelEl = document.getElementById('platform-active-label');
    if (labelEl) labelEl.textContent = `${p.icon} ${p.label}`;

    // Update description
    const descEl = document.getElementById('platform-desc');
    if (descEl) descEl.textContent = p.description;

    this._updateStatus(this.webviews.get(platformId)?.getURL() || p.url);
  }

  // ── Inject John into current platform ─────────────────────────────────────
  async injectJohn(autoSubmit = false) {
    const platformId = this.activePlatformId;
    const wv         = this.webviews.get(platformId);
    if (!wv) { this._setStatus('No platform selected.', 'error'); return; }

    // Get the full prompt from persona engine
    const prompt = typeof personaEngine !== 'undefined'
      ? personaEngine.buildSystemPrompt()
      : (typeof JOHN_MODICA_SYSTEM_PROMPT !== 'undefined' ? JOHN_MODICA_SYSTEM_PROMPT : '');

    if (!prompt) { this._setStatus('Persona engine not loaded.', 'error'); return; }

    const platform = PLATFORMS[platformId];
    this._setStatus('Injecting John Modica AI…', 'info');

    if (this.injectBtn) {
      this.injectBtn.textContent = '⌛ Injecting…';
      this.injectBtn.disabled    = true;
    }

    // Short delay for platform readiness
    await new Promise(r => setTimeout(r, platform.preInjectDelay || 200));

    try {
      const script = buildInjectionScript(platformId, prompt);
      const result = await wv.executeJavaScript(script);

      if (result && result.success) {
        this._setStatus(`✓ John injected (${result.length.toLocaleString()} chars). Review then submit.`, 'success');
        window.appController?.toast(`John Modica AI injected into ${platform.label}`, 'success');

        // Auto-submit option
        if (autoSubmit) {
          await new Promise(r => setTimeout(r, 500));
          const submitScript = buildSubmitScript(platformId);
          const submitResult  = await wv.executeJavaScript(submitScript);
          if (submitResult?.submitted) {
            this._setStatus(`✓ Submitted via ${submitResult.method}. John is now active.`, 'success');
          }
        }
      } else {
        const errMsg = result?.error || 'Input field not found';
        this._setStatus(`⚠ ${errMsg} — open a chat first`, 'error');
        window.appController?.toast(`Injection failed: ${errMsg}`, 'error');
      }
    } catch (e) {
      this._setStatus(`⚠ Error: ${e.message}`, 'error');
      window.appController?.toast(`Injection error: ${e.message}`, 'error');
    } finally {
      if (this.injectBtn) {
        this.injectBtn.textContent = '⬡ Inject John';
        this.injectBtn.disabled    = false;
      }
    }
  }

  // ── Inject + auto-submit ───────────────────────────────────────────────────
  async injectAndSubmit() {
    return this.injectJohn(true);
  }

  // ── Go to login page ───────────────────────────────────────────────────────
  _goToLogin() {
    const platformId = this.activePlatformId;
    const p          = PLATFORMS[platformId];
    const wv         = this.webviews.get(platformId);
    if (wv && p) wv.src = p.loginUrl;
  }

  // ── Navigate current platform webview ─────────────────────────────────────
  navigate(url) {
    const wv = this.webviews.get(this.activePlatformId);
    if (wv) wv.src = url;
  }

  reload() {
    const wv = this.webviews.get(this.activePlatformId);
    if (wv) wv.reload();
  }

  goBack() {
    const wv = this.webviews.get(this.activePlatformId);
    if (wv && wv.canGoBack()) wv.goBack();
  }

  goForward() {
    const wv = this.webviews.get(this.activePlatformId);
    if (wv && wv.canGoForward()) wv.goForward();
  }

  // ── Status helpers ─────────────────────────────────────────────────────────
  _updateStatus(url) {
    if (!this.statusEl) return;
    try {
      const u = new URL(url || '');
      this.statusEl.textContent = u.hostname + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      this.statusEl.textContent = url || '';
    }
  }

  _setStatus(msg, type = 'info') {
    const el = document.getElementById('platform-inject-status');
    if (!el) return;
    el.textContent  = msg;
    el.dataset.type = type;
  }

  // ── Copy prompt to clipboard ───────────────────────────────────────────────
  async copyPromptToClipboard() {
    const prompt = typeof personaEngine !== 'undefined'
      ? personaEngine.buildSystemPrompt()
      : '';
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    window.appController?.toast('John Modica AI prompt copied to clipboard. Paste into any chat.', 'success');
    this._setStatus('✓ Prompt copied to clipboard', 'success');
  }

  // ── Get all platform info (for settings) ──────────────────────────────────
  getPlatforms() { return PLATFORMS; }
  getActivePlatform() { return PLATFORMS[this.activePlatformId]; }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const platformManager = new PlatformManager();
if (typeof window !== 'undefined') window.platformManager = platformManager;
