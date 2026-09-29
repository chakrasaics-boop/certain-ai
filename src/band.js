// Band room: the coordination layer between CertAIn's three agents.
//
// Agents never call each other directly. Scout, SafetyCritic and Executor only
// talk by posting @mention messages into one room, and each only reacts to
// messages that mention it (Band's routing rule). Two transports, same contract:
//
//  - BandRestTransport: real Band (https://app.band.ai) Agent API. Each agent
//    posts with its own API key; each agent polls the room for messages that
//    mention it; Executor is added with POST /chats/{id}/participants at runtime.
//  - InProcessTransport: a local bus with the same routing, so the demo runs
//    with zero config. The UI shows the room either way.
//
// Removing the room breaks the product: Scout only learns APPROVE/VETO from
// SafetyCritic's messages, and Executor only acts on Scout's handoff messages.

const { EventEmitter } = require('events');

const AGENTS = ['Scout', 'SafetyCritic', 'Executor'];
const envKey = (name) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); // SafetyCritic -> SAFETY_CRITIC

function bandConfig() {
  const cfg = {
    baseURL: (process.env.BAND_BASE_URL || 'https://app.band.ai').replace(/\/$/, ''),
    roomId: process.env.BAND_ROOM_ID,
    agents: {},
  };
  for (const a of AGENTS) {
    const k = envKey(a);
    cfg.agents[a] = {
      apiKey: process.env[`BAND_${k}_API_KEY`],
      id: process.env[`BAND_${k}_ID`],
      handle: process.env[`BAND_${k}_HANDLE`] || a,
    };
  }
  cfg.enabled = Boolean(cfg.roomId && AGENTS.every((a) => cfg.agents[a].apiKey && cfg.agents[a].id));
  return cfg;
}

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

class InProcessTransport {
  constructor() {
    this.kind = 'in-process';
    this.label = 'in-process room (set BAND_* env for app.band.ai)';
    this.handlers = new Map();
  }
  async start() {}
  subscribe(agent, handler) {
    this.handlers.set(agent, handler);
  }
  async addParticipant() {
    return { status: 'added' };
  }
  async removeParticipant(_by, agent) {
    this.handlers.delete(agent);
  }
  async post(msg) {
    // Band routing: deliver only to mentioned agents that are in the room.
    for (const m of msg.mentions) {
      const h = this.handlers.get(m);
      if (h && msg.from !== m) setImmediate(() => h(msg));
    }
    return { id: msg.id };
  }
  async event() {}
  stop() {}
}

class BandRestTransport {
  constructor(cfg) {
    this.kind = 'band';
    this.cfg = cfg;
    this.label = `app.band.ai room ${cfg.roomId}`;
    this.handlers = new Map();
    this.seen = new Set();
    this.timers = new Map();
  }

  async req(agent, method, path, body) {
    const a = this.cfg.agents[agent];
    const res = await fetch(`${this.cfg.baseURL}/api/v1/agent${path}`, {
      method,
      headers: { 'X-API-Key': a.apiKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Band ${method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
    return text ? JSON.parse(text) : {};
  }

  async start() {
    await this.req('Scout', 'GET', '/me');
  }

  subscribe(agent, handler) {
    this.handlers.set(agent, handler);
    const poll = async () => {
      if (!this.handlers.has(agent)) return;
      try {
        const r = await this.req(agent, 'GET', `/chats/${this.cfg.roomId}/messages?sort_order=desc&page_size=30`);
        const items = (r.data || r.messages || []).slice().reverse();
        for (const m of items) {
          const id = m.id || m.message_id;
          const key = `${agent}:${id}`;
          if (!id || this.seen.has(key)) continue;
          this.seen.add(key);
          const content = m.content || '';
          const senderId = m.sender_id || m.sender?.id;
          if (senderId === this.cfg.agents[agent].id) continue;
          const handle = this.cfg.agents[agent].handle;
          if (!content.includes(`@${handle}`) && !content.includes(`@${agent}`)) continue;
          const from = AGENTS.find((a) => this.cfg.agents[a].id === senderId) || 'human';
          handler({ id, from, user: m.sender_name || m.sender?.name || m.sender?.handle, text: content, mentions: [agent], viaBand: true });
          this.req(agent, 'POST', `/chats/${this.cfg.roomId}/messages/${id}/processed`).catch(() => {});
        }
      } catch (err) {
        if (!this.lastErr || Date.now() - this.lastErr > 10000) console.warn(`[band] poll ${agent}: ${err.message}`);
        this.lastErr = Date.now();
      }
    };
    // Mark existing history as seen so an old audit is not replayed.
    this.req(agent, 'GET', `/chats/${this.cfg.roomId}/messages?sort_order=desc&page_size=50`)
      .then((r) => (r.data || r.messages || []).forEach((m) => this.seen.add(`${agent}:${m.id || m.message_id}`)))
      .catch(() => {})
      .finally(() => {
        clearInterval(this.timers.get(agent));
        this.timers.set(agent, setInterval(poll, Number(process.env.BAND_POLL_MS || 1200)));
      });
  }

  async addParticipant(by, agent) {
    const id = this.cfg.agents[agent].id;
    try {
      await this.req(by, 'POST', `/chats/${this.cfg.roomId}/participants`, { participant: { participant_id: id, role: 'member' } });
      return { status: 'added' };
    } catch (err) {
      if (/already|409|422/.test(err.message)) return { status: 'already_in_room' };
      throw err;
    }
  }

  async removeParticipant(by, agent) {
    this.handlers.delete(agent);
    clearInterval(this.timers.get(agent));
    await this.req(by, 'DELETE', `/chats/${this.cfg.roomId}/participants/${this.cfg.agents[agent].id}`).catch(() => {});
  }

  async post(msg) {
    const mentions = msg.mentions.filter((m) => this.cfg.agents[m]).map((m) => ({ id: this.cfg.agents[m].id, handle: this.cfg.agents[m].handle }));
    const content = msg.text.replace(/@(Scout|SafetyCritic|Executor)\b/g, (_, a) => `@${this.cfg.agents[a].handle}`);
    const r = await this.req(msg.from === 'human' ? 'Scout' : msg.from, 'POST', `/chats/${this.cfg.roomId}/messages`, { message: { content, mentions } });
    return { id: r.data?.id || msg.id };
  }

  async event(from, content, type = 'thought') {
    await this.req(from, 'POST', `/chats/${this.cfg.roomId}/events`, { event: { content, message_type: type } }).catch(() => {});
  }

  stop() {
    this.timers.forEach((t) => clearInterval(t));
  }
}

/** The room the agents share. Also mirrors every message to the UI. */
class Room extends EventEmitter {
  constructor() {
    super();
    const cfg = bandConfig();
    this.transport = cfg.enabled ? new BandRestTransport(cfg) : new InProcessTransport();
    this.participants = new Set(['human']);
    this.history = [];
  }

  get mode() {
    return this.transport.kind;
  }

  async start() {
    try {
      await this.transport.start();
    } catch (err) {
      console.warn(`[band] ${err.message}; falling back to in-process room`);
      this.transport = new InProcessTransport();
    }
    return this;
  }

  join(agent, handler) {
    this.participants.add(agent);
    this.transport.subscribe(agent, handler);
    this.mirror({ kind: 'system', from: 'band', text: `${agent} joined the room` });
  }

  async recruit(by, agent, handler, why) {
    const r = await this.transport.addParticipant(by, agent);
    if (!this.participants.has(agent)) {
      this.participants.add(agent);
      this.transport.subscribe(agent, handler);
    }
    this.mirror({ kind: 'system', from: 'band', text: `${by} added ${agent} to the room${why ? ` (${why})` : ''}`, recruit: agent, status: r.status });
  }

  has(agent) {
    return this.participants.has(agent);
  }

  mirror(m) {
    const msg = { id: newId(), at: new Date().toISOString(), mentions: [], ...m };
    this.history.push(msg);
    this.emit('message', msg);
    return msg;
  }

  /** Post a chat message. `data` is UI-only decoration; coordination uses `text`. */
  async post(from, text, { mentions = [], data, tone, user } = {}) {
    const msg = this.mirror({ kind: 'chat', from, text, mentions, data, tone, user });
    await this.transport.post(msg).catch((err) => this.mirror({ kind: 'system', from: 'band', text: `delivery failed: ${err.message}` }));
    return msg;
  }

  /** Band "events": thoughts / tool calls. No mentions, nobody is woken up. */
  async thought(from, text, level = 'think') {
    this.mirror({ kind: 'event', from, text, level });
    this.transport.event(from, text, 'thought');
  }

  /** Remove an agent (used on reset so Executor is recruited again next time). */
  async dismiss(by, agent) {
    if (!this.participants.has(agent)) return;
    this.participants.delete(agent);
    await this.transport.removeParticipant(by, agent);
  }

  reset() {
    this.history = [];
  }
}

module.exports = { Room, bandConfig, AGENTS };
