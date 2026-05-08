// ─── webviews.js ──────────────────────────────────────────────────────────────
// John Modica AI Shell — Browser Panel + Platform Manager Bridge
//
// Two sub-systems:
//   1. General browser panel  — free navigation, AI page summarisation
//   2. Platforms panel bridge — delegates to platformManager (ai-platforms.js)
//
// The Platforms panel is a separate panel (data-panel="platforms") that
// renders its own webviews with the "Inject John" flow.
// This file manages only the free-browse webview panel (data-panel="webview").
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

class WebViewManager {
  constructor() {
    this.webview       = null;
    this.urlBar        = null;
    this.homeUrl       = 'https://www.google.com';
    this._loading      = false;
    this._favIconCache = new Map();
    this._history      = [];        // simple local nav history
    this._histIdx      = -1;
    this._bookmarks    = [];
    this._tabCounter   = 0;
    this._tabs         = new Map(); // tabId -> { url, title, webview }
    this.activeTabId   = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════════════
  init() {
    this.webview = document.getElementById('webview-frame');
    this.urlBar  = document.getElementById('url-bar');
    if (!this.webview) return;

    this._bindNavButtons();
    this._bindUrlBar();
    this._bindWebviewEvents();
    this._bindAIButtons();
    this._bindTabBar();
    this._loadBookmarks();

    // Quick-launch tiles for platforms — clicking opens platforms panel
    document.querySelectorAll('[data-open-platform]').forEach(el => {
      el.addEventListener('click', () => {
        const pid = el.dataset.openPlatform;
        // Switch to platforms panel and select the platform
        window.appController?.switchPanel('platforms');
        platformManager?.switchPlatform(pid);
      });
    });

    // Open start page
    this.navigate(this.homeUrl);
  }

  // ── Navigation buttons ─────────────────────────────────────────────────────
  _bindNavButtons() {
    document.getElementById('browser-back')    ?.addEventListener('click', () => this._back());
    document.getElementById('browser-forward') ?.addEventListener('click', () => this._forward());
    document.getElementById('browser-refresh') ?.addEventListener('click', () => this._refresh());
    document.getElementById('browser-home')    ?.addEventListener('click', () => this.navigate(this.homeUrl));
    document.getElementById('browser-new-tab') ?.addEventListener('click', () => this.newTab());

    // Stop button (shows during load)
    document.getElementById('browser-stop')?.addEventListener('click', () => {
      this.webview?.stop();
    });

    // Bookmark current page
    document.getElementById('browser-bookmark')?.addEventListener('click', () => {
      this._bookmarkCurrent();
    });

    // Bookmarks dropdown toggle
    document.getElementById('browser-bm-btn')?.addEventListener('click', () => {
      this._toggleBookmarksPanel();
    });

    // Open DevTools for webview (dev mode)
    document.getElementById('browser-devtools')?.addEventListener('click', () => {
      this.webview?.openDevTools();
    });
  }

  // ── URL bar ────────────────────────────────────────────────────────────────
  _bindUrlBar() {
    if (!this.urlBar) return;

    this.urlBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.navigate(this._resolveUrl(this.urlBar.value.trim()));
      }
      if (e.key === 'Escape') {
        this.urlBar.value = this.webview?.getURL() || '';
        this.urlBar.blur();
      }
    });

    // Select all on focus
    this.urlBar.addEventListener('focus', () => this.urlBar.select());
  }

  // ── Webview events ─────────────────────────────────────────────────────────
  _bindWebviewEvents() {
    if (!this.webview) return;
    const wv = this.webview;

    wv.addEventListener('did-navigate', (e) => {
      this._onNavigated(e.url);
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) this._onNavigated(e.url);
    });
    wv.addEventListener('did-start-loading', () => {
      this._setLoading(true);
    });
    wv.addEventListener('did-stop-loading', () => {
      this._setLoading(false);
      this._updateNavButtons();
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode !== -3) {                          // -3 = ERR_ABORTED (normal)
        this._showErrorPage(e.errorDescription, e.validatedURL);
      }
      this._setLoading(false);
    });
    wv.addEventListener('page-title-updated', (e) => {
      this._setTabTitle(this.activeTabId, e.title);
      document.getElementById('browser-title-bar')
        ? (document.getElementById('browser-title-bar').textContent = e.title)
        : null;
    });
    wv.addEventListener('page-favicon-updated', (e) => {
      if (e.favicons?.length) {
        const favicon = document.getElementById('browser-favicon');
        if (favicon) favicon.src = e.favicons[0];
      }
    });
    wv.addEventListener('new-window', (e) => {
      // Redirect new-window requests into our browser
      e.preventDefault?.();
      this.navigate(e.url);
    });
    // Forward console messages in dev mode
    wv.addEventListener('console-message', (e) => {
      if (process?.env?.NODE_ENV === 'development') {
        console.log(`[WebView console] ${e.message}`);
      }
    });
  }

  // ── AI action buttons ──────────────────────────────────────────────────────
  _bindAIButtons() {
    // Summarise current page
    document.getElementById('browser-ai-page')?.addEventListener('click', () => {
      this._summarisePage();
    });

    // Extract & analyse links
    document.getElementById('browser-ai-links')?.addEventListener('click', () => {
      this._extractLinks();
    });

    // Screenshot to AI
    document.getElementById('browser-ai-screenshot')?.addEventListener('click', () => {
      this._screenshotToAI();
    });

    // Quick search selection
    document.getElementById('browser-ai-selection')?.addEventListener('click', () => {
      this._analyseSelection();
    });
  }

  // ── Tab bar wiring ─────────────────────────────────────────────────────────
  _bindTabBar() {
    document.getElementById('browser-new-tab-btn')?.addEventListener('click', () => this.newTab());
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  NAVIGATION
  // ══════════════════════════════════════════════════════════════════════════
  navigate(url) {
    if (!this.webview || !url) return;
    const resolved = this._resolveUrl(url);
    this.webview.src = resolved;
    if (this.urlBar) this.urlBar.value = resolved;
    this._pushHistory(resolved);
  }

  _resolveUrl(input) {
    if (!input) return this.homeUrl;
    input = input.trim();
    if (input.startsWith('http://') || input.startsWith('https://')) return input;
    if (input.startsWith('//')) return 'https:' + input;
    // Domain-like (has TLD)
    if (/^[\w-]+\.[a-zA-Z]{2,}/.test(input) && !input.includes(' ')) {
      return 'https://' + input;
    }
    // Treat as Google search
    return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  }

  _back() {
    if (this.webview?.canGoBack()) this.webview.goBack();
  }

  _forward() {
    if (this.webview?.canGoForward()) this.webview.goForward();
  }

  _refresh() {
    this.webview?.reload();
  }

  _pushHistory(url) {
    this._history = this._history.slice(0, this._histIdx + 1);
    this._history.push(url);
    this._histIdx = this._history.length - 1;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TABS  (multi-tab browser panel)
  // ══════════════════════════════════════════════════════════════════════════
  newTab(url = this.homeUrl) {
    this._tabCounter++;
    const tabId = `btab-${this._tabCounter}`;

    // Create webview for this tab
    const wv = document.createElement('webview');
    wv.src            = this._resolveUrl(url);
    wv.style.cssText  = 'width:100%;height:100%;border:none;display:none;';
    wv.setAttribute('allowpopups', '');
    wv.addEventListener('did-navigate', (e) => {
      if (this.activeTabId === tabId) {
        if (this.urlBar) this.urlBar.value = e.url;
        this._updateNavButtons();
      }
    });
    wv.addEventListener('page-title-updated', (e) => {
      this._setTabTitle(tabId, e.title);
    });
    wv.addEventListener('did-start-loading', () => {
      if (this.activeTabId === tabId) this._setLoading(true);
    });
    wv.addEventListener('did-stop-loading', () => {
      if (this.activeTabId === tabId) this._setLoading(false);
    });

    const wvContainer = document.getElementById('browser-webview-container') ||
                        document.getElementById('webview-panel');
    wvContainer?.appendChild(wv);

    this._tabs.set(tabId, { url, title: 'New Tab', webview: wv });

    // Create tab button
    const tabBar = document.getElementById('browser-tab-bar');
    if (tabBar) {
      const btn = document.createElement('div');
      btn.id        = `btn-${tabId}`;
      btn.className = 'browser-tab';
      btn.dataset.tabId = tabId;
      btn.innerHTML = `<span class="btab-title">New Tab</span><button class="btab-close" title="Close tab">✕</button>`;
      btn.querySelector('.btab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTab(tabId);
      });
      btn.addEventListener('click', (e) => {
        if (!e.target.classList.contains('btab-close')) this.switchTab(tabId);
      });
      tabBar.appendChild(btn);
    }

    this.switchTab(tabId);
    return tabId;
  }

  switchTab(tabId) {
    if (!this._tabs.has(tabId)) return;
    const prev = this._tabs.get(this.activeTabId);
    if (prev?.webview) prev.webview.style.display = 'none';

    this.activeTabId = tabId;
    const tab = this._tabs.get(tabId);
    tab.webview.style.display = 'flex';
    this.webview = tab.webview;   // point the singleton ref at the active wv

    if (this.urlBar) this.urlBar.value = tab.webview.getURL() || tab.url;
    this._updateNavButtons();

    // Update tab button styles
    document.querySelectorAll('.browser-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tabId === tabId);
    });
  }

  closeTab(tabId) {
    const tab = this._tabs.get(tabId);
    if (!tab) return;
    tab.webview.remove();
    document.getElementById(`btn-${tabId}`)?.remove();
    this._tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      const remaining = [...this._tabs.keys()];
      if (remaining.length > 0) {
        this.switchTab(remaining[remaining.length - 1]);
      } else {
        this.newTab();
      }
    }
  }

  _setTabTitle(tabId, title) {
    const tab = this._tabs.get(tabId);
    if (tab) tab.title = title;
    const btn = document.querySelector(`#btn-${tabId} .btab-title`);
    if (btn) btn.textContent = title.slice(0, 22) || 'New Tab';
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AI INTEGRATIONS
  // ══════════════════════════════════════════════════════════════════════════

  // Extracts visible text from page → sends to chat for summarisation
  async _summarisePage() {
    if (!this.webview) return;
    this._setStatus('Extracting page…');
    try {
      const content = await this.webview.executeJavaScript(`
        (function() {
          const body    = document.body;
          const title   = document.title;
          const url     = location.href;
          // Get readable text — strip scripts, styles, nav
          ['script','style','nav','footer','aside','iframe','svg'].forEach(t => {
            body.querySelectorAll(t).forEach(el => el.remove());
          });
          const text = body.innerText.replace(/\\s+/g,' ').trim().slice(0, 6000);
          return { title, url, text };
        })()
      `);
      const q = `Summarise this web page for me:\n\nTitle: ${content.title}\nURL: ${content.url}\n\nContent:\n${content.text}`;
      this._sendToChat(q, 'pure-intel');
    } catch (e) {
      window.appController?.toast('Could not extract page content: ' + e.message, 'error');
    }
    this._clearStatus();
  }

  // Extract and analyse all links on page
  async _extractLinks() {
    if (!this.webview) return;
    try {
      const links = await this.webview.executeJavaScript(`
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
          .filter(l => l.href.startsWith('http') && l.text)
          .slice(0, 50)
      `);
      if (!links.length) { window.appController?.toast('No links found.', 'info'); return; }
      const formatted = links.map((l,i) => `${i+1}. [${l.text}](${l.href})`).join('\n');
      this._sendToChat(`Analyse these links from the page I'm viewing:\n\n${formatted}`, 'pure-intel');
    } catch (e) {
      window.appController?.toast('Link extraction failed: ' + e.message, 'error');
    }
  }

  // Analyse selected text on page
  async _analyseSelection() {
    if (!this.webview) return;
    try {
      const text = await this.webview.executeJavaScript(`window.getSelection().toString().trim()`);
      if (!text) { window.appController?.toast('Select some text on the page first.', 'info'); return; }
      this._sendToChat(`Analyse this selected text from the page:\n\n"${text.slice(0, 4000)}"`, 'pure-intel');
    } catch (e) {
      window.appController?.toast('Selection read failed: ' + e.message, 'error');
    }
  }

  // Capture visible region screenshot description
  async _screenshotToAI() {
    if (!this.webview) return;
    window.appController?.toast('Screenshot → AI coming in v2.1 (requires capturePage API)', 'info');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  BOOKMARKS
  // ══════════════════════════════════════════════════════════════════════════
  async _loadBookmarks() {
    try {
      const raw = await window.api.settings.get('browser_bookmarks');
      this._bookmarks = raw ? JSON.parse(raw) : this._defaultBookmarks();
    } catch {
      this._bookmarks = this._defaultBookmarks();
    }
    this._renderBookmarks();
  }

  _defaultBookmarks() {
    return [
      { title: 'Character AI',  url: 'https://character.ai',           icon: '🎭' },
      { title: 'Blackbox AI',   url: 'https://www.blackbox.ai',         icon: '⬛' },
      { title: 'Google Gemini', url: 'https://gemini.google.com',       icon: '✦'  },
      { title: 'HuggingChat',   url: 'https://huggingface.co/chat',     icon: '🤗' },
      { title: 'ChatGPT',       url: 'https://chatgpt.com',             icon: '🟢' },
      { title: 'Claude',        url: 'https://claude.ai',               icon: '🧡' },
      { title: 'Shodan',        url: 'https://www.shodan.io',           icon: '🔍' },
      { title: 'CVE Details',   url: 'https://cvedetails.com',          icon: '🛡️' },
      { title: 'VirusTotal',    url: 'https://www.virustotal.com',      icon: '🦠' },
      { title: 'ExploitDB',     url: 'https://www.exploit-db.com',      icon: '💣' },
      { title: 'pure-intel',    url: 'https://pure-intel.github.io',    icon: '🧠' },
      { title: 'CybernetiX S3C',url: 'https://github.com/cybernetix-s3c', icon: '⬡' },
    ];
  }

  async _bookmarkCurrent() {
    if (!this.webview) return;
    const url   = this.webview.getURL() || '';
    const title = await this.webview.executeJavaScript('document.title').catch(() => url);
    if (!url || url === this.homeUrl) return;
    const exists = this._bookmarks.some(b => b.url === url);
    if (!exists) {
      this._bookmarks.push({ title: title.slice(0, 40), url, icon: '🔖' });
      await window.api.settings.set('browser_bookmarks', JSON.stringify(this._bookmarks));
      this._renderBookmarks();
      window.appController?.toast('Bookmarked: ' + title.slice(0, 30), 'success');
    } else {
      window.appController?.toast('Already bookmarked.', 'info');
    }
  }

  _renderBookmarks() {
    const container = document.getElementById('bookmarks-list');
    if (!container) return;
    container.innerHTML = '';
    for (const bm of this._bookmarks) {
      const el = document.createElement('div');
      el.className = 'bookmark-item';
      el.title     = bm.url;
      el.innerHTML = `<span class="bm-icon">${bm.icon||'🔖'}</span><span class="bm-title">${bm.title}</span>`;
      el.addEventListener('click', () => {
        this.navigate(bm.url);
        this._toggleBookmarksPanel(false);
      });
      container.appendChild(el);
    }
  }

  _toggleBookmarksPanel(force) {
    const panel = document.getElementById('bookmarks-panel');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open', force !== undefined ? force : !isOpen);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  UI HELPERS
  // ══════════════════════════════════════════════════════════════════════════
  _onNavigated(url) {
    if (this.urlBar) this.urlBar.value = url;
    this._setStatus('');
    this._updateNavButtons();
  }

  _setLoading(on) {
    this._loading = on;
    document.getElementById('browser-spinner')?.classList.toggle('active', on);
    document.getElementById('browser-stop')   ?.classList.toggle('visible', on);
    document.getElementById('browser-refresh')?.classList.toggle('hidden', on);
  }

  _updateNavButtons() {
    const back    = document.getElementById('browser-back');
    const forward = document.getElementById('browser-forward');
    if (!this.webview) return;
    if (back)    back.disabled    = !this.webview.canGoBack?.();
    if (forward) forward.disabled = !this.webview.canGoForward?.();
  }

  _setStatus(msg) {
    const el = document.getElementById('browser-status-bar');
    if (el) el.textContent = msg;
  }

  _clearStatus() {
    this._setStatus('');
  }

  _showErrorPage(desc, url) {
    const msg = `Could not load: ${url}\n${desc}`;
    window.appController?.toast(msg, 'error');
  }

  // Send text query to the Chat panel (switch to chat + inject as user message)
  _sendToChat(text, mode) {
    if (window.appController) {
      window.appController.switchPanel('chat');
      if (mode) window.appController.setMode(mode);
      window.appController.sendMessage(text);
    }
  }

  // Public getter for current URL
  getCurrentUrl() {
    try { return this.webview?.getURL() || ''; } catch { return ''; }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const webViewManager = new WebViewManager();
if (typeof window !== 'undefined') window.webViewManager = webViewManager;
