// ─── storage.js ───────────────────────────────────────────────────────────────
// Renderer-side storage API. All DB operations proxied to main via IPC.
// ─────────────────────────────────────────────────────────────────────────────

class StorageManager {
  // ── Conversations ──────────────────────────────────────────────────────────
  async createConversation(title = 'New Chat', mode = 'general', model = 'tinyllama') {
    const r = await window.api.db.run(
      'INSERT INTO conversations (title, mode, model) VALUES (?, ?, ?)',
      [title, mode, model]
    );
    return r.lastInsertRowid;
  }

  async getConversations(limit = 100) {
    return window.api.db.all(
      'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?', [limit]
    );
  }

  async getConversation(id) {
    return window.api.db.get('SELECT * FROM conversations WHERE id = ?', [id]);
  }

  async updateConversation(id, fields) {
    const keys   = Object.keys(fields);
    const values = Object.values(fields);
    const sets   = keys.map(k => `${k} = ?`).join(', ');
    await window.api.db.run(
      `UPDATE conversations SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
      [...values, id]
    );
  }

  async deleteConversation(id) {
    await window.api.db.run('DELETE FROM conversations WHERE id = ?', [id]);
  }

  async deleteAllConversations() {
    await window.api.db.run('DELETE FROM conversations');
    await window.api.db.run('DELETE FROM messages');
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  async addMessage(conversationId, role, content, meta = {}) {
    const r = await window.api.db.run(
      'INSERT INTO messages (conversation_id, role, content, mode, model, token_count) VALUES (?, ?, ?, ?, ?, ?)',
      [conversationId, role, content, meta.mode || null, meta.model || null, meta.tokenCount || 0]
    );
    // Touch conversation updated_at
    await window.api.db.run(
      "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?", [conversationId]
    );
    return r.lastInsertRowid;
  }

  async getMessages(conversationId) {
    return window.api.db.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC', [conversationId]
    );
  }

  async deleteMessage(id) {
    await window.api.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  async getSetting(key)             { return window.api.settings.get(key); }
  async setSetting(key, value)      { return window.api.settings.set(key, value); }
  async getAllSettings()            { return window.api.settings.getAll(); }

  async setSettings(obj) {
    const ops = Object.entries(obj).map(([key, value]) => ({
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: [key, String(value)], mode: 'run'
    }));
    return window.api.db.transaction(ops);
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  async exportConversationJSON(conversationId) {
    const conv = await this.getConversation(conversationId);
    const msgs = await this.getMessages(conversationId);
    return JSON.stringify({ conversation: conv, messages: msgs }, null, 2);
  }

  async exportConversationMarkdown(conversationId) {
    const conv = await this.getConversation(conversationId);
    const msgs = await this.getMessages(conversationId);
    let md = `# ${conv.title}\n\n**Mode:** ${conv.mode} | **Model:** ${conv.model} | **Date:** ${conv.created_at}\n\n---\n\n`;
    for (const m of msgs) {
      const who = m.role === 'user' ? '**You**' : '**John Modica AI**';
      md += `${who}\n\n${m.content}\n\n---\n\n`;
    }
    return md;
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  async searchMessages(query) {
    return window.api.db.all(
      `SELECT m.*, c.title as conv_title FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.content LIKE ?
       ORDER BY m.id DESC LIMIT 50`,
      [`%${query}%`]
    );
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  async getStats() {
    const convCount = await window.api.db.get('SELECT COUNT(*) as n FROM conversations');
    const msgCount  = await window.api.db.get('SELECT COUNT(*) as n FROM messages');
    const tokCount  = await window.api.db.get('SELECT SUM(token_count) as n FROM messages');
    return {
      conversations: convCount?.n || 0,
      messages:      msgCount?.n  || 0,
      totalTokens:   tokCount?.n  || 0
    };
  }
}

const storageManager = new StorageManager();
if (typeof window !== 'undefined') window.storageManager = storageManager;
