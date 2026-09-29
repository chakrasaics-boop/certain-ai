// Crusoe Managed Inference client (OpenAI-compatible) with token + cost accounting,
// a hard per-audit budget cap, and graceful fallback to canned reasoning.

const CRUSOE_BASE_URL = process.env.CRUSOE_BASE_URL || 'https://api.inference.crusoecloud.com/v1';

const MODELS = {
  planner: {
    id: process.env.PLANNER_MODEL || 'moonshotai/Kimi-K2.6',
    label: 'Kimi K2.6',
    // USD per 1M tokens. Set to your Crusoe rate card via env.
    priceIn: Number(process.env.PLANNER_PRICE_IN || 1.0),
    priceOut: Number(process.env.PLANNER_PRICE_OUT || 3.0),
  },
  checker: {
    id: process.env.CHECKER_MODEL || 'nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B',
    label: 'Nemotron 3 Nano',
    priceIn: Number(process.env.CHECKER_PRICE_IN || 0.1),
    priceOut: Number(process.env.CHECKER_PRICE_OUT || 0.4),
  },
};

const BUDGET_USD = Number(process.env.AUDIT_BUDGET_USD || 0.5);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 45000);

let client = null;
function getClient() {
  if (!process.env.CRUSOE_API_KEY) return null;
  if (!client) {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: process.env.CRUSOE_API_KEY, baseURL: CRUSOE_BASE_URL, timeout: TIMEOUT_MS, maxRetries: 1 });
  }
  return client;
}

const isLive = () => Boolean(process.env.CRUSOE_API_KEY) && process.env.DEMO_MODE !== '1';

function costOf(role, tokensIn, tokensOut) {
  const m = MODELS[role];
  return (tokensIn * m.priceIn + tokensOut * m.priceOut) / 1e6;
}

/** Per-audit meter: every call (live or simulated) is recorded here. */
class Meter {
  constructor() {
    this.calls = [];
    this.budget = BUDGET_USD;
  }
  get spent() {
    return this.calls.reduce((a, c) => a + c.cost, 0);
  }
  get tokens() {
    return this.calls.reduce((a, c) => a + c.tokensIn + c.tokensOut, 0);
  }
  canSpend(role, estIn, estOut) {
    return this.spent + costOf(role, estIn, estOut) <= this.budget;
  }
  record(role, tokensIn, tokensOut, ms, live) {
    const call = { role, model: MODELS[role].id, tokensIn, tokensOut, ms, live, cost: costOf(role, tokensIn, tokensOut) };
    this.calls.push(call);
    return call;
  }
  summary() {
    const outTok = this.calls.reduce((a, c) => a + c.tokensOut, 0);
    const ms = this.calls.reduce((a, c) => a + c.ms, 0);
    return {
      spent: this.spent,
      budget: this.budget,
      tokens: this.tokens,
      calls: this.calls.length,
      liveCalls: this.calls.filter((c) => c.live).length,
      tokensPerSec: ms ? Math.round(outTok / (ms / 1000)) : 0,
      byRole: ['planner', 'checker'].map((role) => {
        const cs = this.calls.filter((c) => c.role === role);
        return {
          role,
          model: MODELS[role].id,
          calls: cs.length,
          tokensIn: cs.reduce((a, c) => a + c.tokensIn, 0),
          tokensOut: cs.reduce((a, c) => a + c.tokensOut, 0),
          cost: cs.reduce((a, c) => a + c.cost, 0),
        };
      }),
    };
  }
}

function extractJSON(text) {
  if (!text) throw new Error('empty completion');
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in completion');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function chatJSON(role, system, user, maxTokens) {
  const c = getClient();
  if (!c) throw new Error('no CRUSOE_API_KEY');
  const started = Date.now();
  const res = await c.chat.completions.create({
    model: MODELS[role].id,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  });
  const ms = Date.now() - started;
  const text = res.choices?.[0]?.message?.content || '';
  const usage = res.usage || {};
  return {
    json: extractJSON(text),
    tokensIn: usage.prompt_tokens || Math.ceil((system.length + user.length) / 4),
    tokensOut: usage.completion_tokens || Math.ceil(text.length / 4),
    ms,
  };
}

const PLANNER_SYSTEM = `You are CertAIn's planning agent, a senior FinOps + SRE engineer.
Given one cloud resource, its 14-day metrics, the waste detector that flagged it, and its dependency blast radius,
write the finding's rationale and a concrete, reversible fix plan. Be specific and numeric. Never invent metrics.
Respond with ONLY a JSON object:
{"headline": string (<= 90 chars), "rationale": string (2-4 sentences), "plan": string[] (3-4 steps),
 "rollback": string, "risk": "low"|"medium"|"high", "confidence": number 0-1}`;

const CHECKER_SYSTEM = `You are CertAIn's safety checker. You validate a proposed cloud change before a human sees it.
Rules: a destructive action (stop, delete) on a resource with ANY direct dependents must be refused.
Non-destructive changes (resize, scale, route/config change) with dependents are "caution" and need a canary or rollback.
Respond with ONLY a JSON object: {"verdict": "safe"|"caution"|"refuse", "reason": string (1-2 sentences)}`;

module.exports = {
  MODELS,
  BUDGET_USD,
  CRUSOE_BASE_URL,
  Meter,
  isLive,
  chatJSON,
  costOf,
  PLANNER_SYSTEM,
  CHECKER_SYSTEM,
};
