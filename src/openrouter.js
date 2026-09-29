// OpenRouter live model pricing. Used by @Scout to quote what a closed-model LLM
// workload would cost on equivalent open-weight models, next to the Crusoe target.
// Public endpoint, no key needed. Cached for an hour; bundled snapshot as fallback.

const URL = process.env.OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60 * 1000;
const snapshot = require('../data/openrouter-snapshot.json');

// First available match per family (skips :batch / :free variants).
const OPEN_FAMILIES = [
  { family: 'Kimi', re: /^moonshotai\/kimi/i },
  { family: 'DeepSeek', re: /^deepseek\/deepseek-v/i },
  { family: 'GLM', re: /^z-ai\/glm/i },
  { family: 'Qwen', re: /^qwen\/qwen3/i },
  { family: 'Llama', re: /^meta-llama\/llama-.*70b/i },
  { family: 'gpt-oss', re: /^openai\/gpt-oss-120b/i },
  { family: 'Nemotron', re: /^nvidia\/.*nemotron/i },
];
const CLOSED_REFERENCE = (id) => [new RegExp(`^${(id || 'openai/gpt-6-astra').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'i'), /^anthropic\/claude-sonnet/i];

let cache = null;
const state = { source: 'not fetched', fetchedAt: null, count: 0, error: null };

async function getModels() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Number(process.env.OPENROUTER_TIMEOUT_MS || 6000));
    const res = await fetch(URL, { signal: ctrl.signal, headers: { 'User-Agent': 'CertAIn/0.1' } });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.data) || !body.data.length) throw new Error('empty model list');
    cache = { at: Date.now(), data: body.data, source: 'live' };
    Object.assign(state, { source: 'live', fetchedAt: new Date().toISOString(), count: body.data.length, error: null });
  } catch (err) {
    cache = { at: Date.now(), data: snapshot.data, source: 'snapshot' };
    Object.assign(state, { source: 'snapshot', fetchedAt: snapshot.capturedAt, count: snapshot.data.length, error: err.message });
  }
  return cache;
}

const usable = (m) => !/:batch|:free/.test(m.id) && Number(m.pricing?.prompt) > 0;
const monthly = (m, tokensM, inputShare) =>
  tokensM * 1e6 * (inputShare * Number(m.pricing.prompt) + (1 - inputShare) * Number(m.pricing.completion));

/** Quote a monthly token workload across open-weight families + one closed reference. */
async function quoteWorkload(tokensM, inputShare, currentModel) {
  const { data, source } = await getModels();
  const pool = data.filter(usable);
  const rows = [];
  for (const f of OPEN_FAMILIES) {
    const m = pool.filter((x) => f.re.test(x.id)).sort((a, b) => monthly(a, 1, inputShare) - monthly(b, 1, inputShare))[0];
    if (m) rows.push({ family: f.family, model: m.id, monthly: Math.round(monthly(m, tokensM, inputShare)), kind: 'open' });
  }
  let closed = null;
  for (const re of CLOSED_REFERENCE(currentModel)) {
    const m = pool.find((x) => re.test(x.id));
    if (m) {
      closed = { model: m.id, monthly: Math.round(monthly(m, tokensM, inputShare)), kind: 'closed' };
      break;
    }
  }
  rows.sort((a, b) => a.monthly - b.monthly);
  return { source, fetchedAt: state.fetchedAt, modelsSeen: state.count, tokensM, inputShare, rows: rows.slice(0, 4), closed };
}

// What the same audit tokens would cost on a flagship closed model (OpenRouter list price).
const FRONTIER = process.env.FRONTIER_MODEL || 'openai/gpt-6-astra';
function frontierCompare(tokensIn, tokensOut, spent) {
  const data = (cache && cache.data) || snapshot.data;
  const m = data.find((x) => x.id === FRONTIER) || data.find((x) => /^anthropic\/claude-sonnet/.test(x.id) && usable(x));
  if (!m || !spent) return null;
  const pin = Number(m.pricing.prompt) * 1e6;
  const pout = Number(m.pricing.completion) * 1e6;
  const cost = (tokensIn * pin + tokensOut * pout) / 1e6;
  return { model: m.id, source: (cache && cache.source) || 'snapshot', priceIn: pin, priceOut: pout, tokensIn, tokensOut, cost, spent, multiple: cost / spent };
}

module.exports = { getModels, quoteWorkload, frontierCompare, status: () => ({ ...state }) };
