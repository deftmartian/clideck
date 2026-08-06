// Minimal WebSocket client that speaks CliDeck's session protocol, for tests.
// Drives sessions the way the browser does (create / input / resume) and
// observes the server's broadcasts (config / output / session.status / ...).

const WebSocket = require('ws');
const { stripAnsi } = require('../../ansi-utils');
const { CLIENT_PROTOCOL_PARAM, CLIENT_PROTOCOL_VERSION } = require('../../protocol');

class Client {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.messages = [];           // every message received, in order
    this.listeners = new Set();
    this.output = new Map();      // sessionId -> concatenated raw output
    this.working = new Map();     // sessionId -> bool (last known)
    this.statusLog = [];          // { id, working, source } transitions
    this.config = null;           // last { type:'config' } payload
    this.resumable = [];          // last sessions.resumable list
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const url = new URL(`ws://127.0.0.1:${this.port}`);
      url.searchParams.set(CLIENT_PROTOCOL_PARAM, String(CLIENT_PROTOCOL_VERSION));
      this.ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), timeoutMs);
      this.ws.on('open', () => { clearTimeout(timer); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      this.ws.on('message', (raw) => this._onMessage(raw));
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    this.messages.push(msg);

    if (msg.type === 'config') this.config = msg.config;
    else if (msg.type === 'sessions.resumable') this.resumable = msg.list || [];
    else if (msg.type === 'output' || msg.type === 'session.history') {
      const text = msg.data != null ? msg.data : (msg.text || '');
      this.output.set(msg.id, (this.output.get(msg.id) || '') + text);
    } else if (msg.type === 'session.status') {
      this.working.set(msg.id, !!msg.working);
      this.statusLog.push({ id: msg.id, working: !!msg.working, source: msg.source });
    }
    for (const fn of this.listeners) fn(msg);
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  // Resolve with the first message (already-received or future) matching pred.
  // pred is a type string or a function(msg) -> bool.
  waitFor(pred, { timeout = 30000, label } = {}) {
    const test = typeof pred === 'string' ? (m) => m.type === pred : pred;
    const existing = this.messages.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`waitFor timeout (${label || pred}) after ${timeout}ms`));
      }, timeout);
      const fn = (m) => {
        if (!test(m)) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve(m);
      };
      this.listeners.add(fn);
    });
  }

  // The command id for a given preset, from the config the server pushed on connect.
  commandIdFor(presetId) {
    const cmd = (this.config?.commands || []).find((c) => c.presetId === presetId);
    return cmd ? cmd.id : null;
  }

  outputText(id) { return stripAnsi(this.output.get(id) || ''); }

  close() { try { this.ws?.close(); } catch {} }
}

module.exports = { Client };
