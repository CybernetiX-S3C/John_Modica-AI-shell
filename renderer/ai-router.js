// ─── ai-router.js ─────────────────────────────────────────────────────────────
// Handles all AI requests: Ollama (local) + Cloud fallback.
// Full John Modica system prompt injected on every request via personaEngine.
// ─────────────────────────────────────────────────────────────────────────────

class AIRouter {
  constructor() {
    this.settings       = {};
    this.sessionTokens  = 0;
    this.pendingStreams  = new Map(); // requestId -> { onChunk, onDone, onError }
    this._listenersSetup = false;
  }

  async init() {
    this.settings = await window.api.settings.getAll();
    this._setupStreamListeners();
  }

  _setupStreamListeners() {
    if (this._listenersSetup) return;
    this._listenersSetup = true;

    window.api.ai.onChunk(({ requestId, chunk }) => {
      const handler = this.pendingStreams.get(requestId);
      if (!handler) return;
      // Parse Ollama NDJSON or OpenAI SSE lines
      const lines = chunk.split('\n').filter(l => l.trim());
      for (const line of lines) {
        let text = '';
        try {
          // Ollama format: {"model":"...","message":{"role":"assistant","content":"..."}}
          const obj = JSON.parse(line);
          if (obj.message?.content)  text = obj.message.content;
          else if (obj.response)     text = obj.response;
          // OpenAI SSE: data: {"choices":[{"delta":{"content":"..."}}]}
          else if (obj.choices?.[0]?.delta?.content) text = obj.choices[0].delta.content;
        } catch {
          // SSE line starts with "data: "
          const stripped = line.replace(/^data:\s*/, '');
          if (stripped === '[DONE]') continue;
          try {
            const obj = JSON.parse(stripped);
            if (obj.choices?.[0]?.delta?.content) text = obj.choices[0].delta.content;
          } catch { /* ignore */ }
        }
        if (text) handler.onChunk(text);
      }
    });

    window.api.ai.onDone(({ requestId }) => {
      const handler = this.pendingStreams.get(requestId);
      if (handler) { handler.onDone(); this.pendingStreams.delete(requestId); }
    });

    window.api.ai.onError(({ requestId, error }) => {
      const handler = this.pendingStreams.get(requestId);
      if (handler) { handler.onError(error); this.pendingStreams.delete(requestId); }
    });
  }

  /** Refresh settings from DB */
  async refreshSettings() {
    this.settings = await window.api.settings.getAll();
  }

  /** Main entry point — auto-routes based on routingMode setting */
  async chat({ messages, mode, onChunk, onDone, onError, extraContext }) {
    await this.refreshSettings();
    const rm = this.settings.routingMode || 'local';

    // Inject full persona + mode overlay
    const fullMessages = personaEngine.injectIntoMessages(messages, mode, extraContext);

    if (rm === 'cloud') {
      return this._cloudChat({ messages: fullMessages, onChunk, onDone, onError });
    }
    if (rm === 'auto') {
      // Try local first, fall back to cloud on error
      return this._ollamaChat({ messages: fullMessages, onChunk, onDone, onError })
        .catch(() => {
          console.warn('[AIRouter] Ollama failed, falling back to cloud…');
          return this._cloudChat({ messages: fullMessages, onChunk, onDone, onError });
        });
    }
    // Default: local
    return this._ollamaChat({ messages: fullMessages, onChunk, onDone, onError });
  }

  // ── Ollama ─────────────────────────────────────────────────────────────────
  async _ollamaChat({ messages, onChunk, onDone, onError }) {
    const url     = (this.settings.ollamaUrl || 'http://localhost:11434') + '/api/chat';
    const model   = this.settings.ollamaModel || 'tinyllama';
    const stream  = this.settings.streamEnabled !== 'false';
    const payload = { model, messages, stream, options: { num_ctx: 8192 } };

    if (!stream) {
      // Non-streaming: fetch directly from renderer (Ollama is localhost, no CORS issue)
      const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, stream: false }) });
      const data = await res.json();
      const text = data.message?.content || data.response || '';
      onChunk(text);
      this.sessionTokens += (data.eval_count || 0) + (data.prompt_eval_count || 0);
      onDone();
      return;
    }

    // Streaming via main process to avoid any CORS or fetch stream issues
    const requestId = `ollama-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.pendingStreams.set(requestId, { onChunk, onDone, onError });
    window.api.ai.stream(requestId, url, payload, { 'Content-Type': 'application/json' });
  }

  // ── Cloud (OpenAI-compatible) ──────────────────────────────────────────────
  async _cloudChat({ messages, onChunk, onDone, onError }) {
    const baseUrl = this.settings.cloudUrl   || 'https://api.openai.com/v1';
    const apiKey  = this.settings.cloudApiKey || '';
    const model   = this.settings.cloudModel  || 'gpt-4o';
    const url     = baseUrl.replace(/\/$/, '') + '/chat/completions';

    if (!apiKey) { onError('No cloud API key configured. Go to Settings.'); return; }

    const payload = { model, messages, stream: true, max_tokens: 4096 };
    const headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    const requestId = `cloud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.pendingStreams.set(requestId, { onChunk, onDone, onError });
    window.api.ai.stream(requestId, url, payload, headers);
  }

  // ── Health checks ──────────────────────────────────────────────────────────
  async testOllama() {
    try {
      const url = (this.settings.ollamaUrl || 'http://localhost:11434') + '/api/tags';
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return { ok: true, models: (data.models || []).map(m => m.name) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async testCloud() {
    try {
      const baseUrl = this.settings.cloudUrl   || 'https://api.openai.com/v1';
      const apiKey  = this.settings.cloudApiKey || '';
      if (!apiKey) return { ok: false, error: 'No API key configured.' };
      const res  = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      return { ok: true, models: (data.data || []).slice(0, 10).map(m => m.id) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** List available local Ollama models */
  async listOllamaModels() {
    try {
      const url = (this.settings.ollamaUrl || 'http://localhost:11434') + '/api/tags';
      const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      return (data.models || []).map(m => m.name);
    } catch { return []; }
  }

  getSessionTokens() { return this.sessionTokens; }
  resetSessionTokens() { this.sessionTokens = 0; }
}

const aiRouter = new AIRouter();
if (typeof window !== 'undefined') window.aiRouter = aiRouter;
