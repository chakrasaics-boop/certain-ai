// The audit pipeline: detect -> blast radius -> plan (Kimi) -> safety check (Nemotron) -> policy guard.
// Building blocks used by the agents in agents.js. `emit(level, text)` posts a Band thought.

const { detect, graphCandidate } = require('./detectors');
const { estimateSavings } = require('./co2');
const llm = require('./llm');

// Simulated token usage per call in demo mode (roughly what the live prompts use).
const CANNED_USAGE = {
  planner: { tokensIn: 3000, tokensOut: 560, ms: 2450 },
  checker: { tokensIn: 2300, tokensOut: 340, ms: 800 },
};

const SPEED = Number(process.env.DEMO_SPEED || 1); // >1 = faster canned pacing (tests)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const RANK = { safe: 0, caution: 1, refuse: 2 };

// Merge per-resource blast radii for a multi-resource finding. Dependents that are
// themselves part of the target set are not "outside" dependents and are excluded.
function mergeBlast(blasts) {
  if (blasts.length > 1) {
    const targets = new Set(blasts.map((b) => b.params.id));
    blasts = blasts.map((b) => {
      const dependents = b.dependents.filter((d) => !targets.has(d.id));
      return {
        ...b,
        dependents,
        directCount: dependents.filter((d) => d.hops === 1).length,
        totalCount: dependents.length,
        nodes: b.nodes.map((n) => (targets.has(n.id) ? { ...n, role: 'target' } : n)),
      };
    });
  }
  if (blasts.length === 1) return blasts[0];
  const nodes = new Map();
  const edges = [];
  blasts.forEach((b) => {
    b.nodes.forEach((n) => nodes.set(n.id, n));
    edges.push(...b.edges);
  });
  const merged = {
    ...blasts[0],
    params: { ids: blasts.map((b) => b.params.id) },
    ms: blasts.reduce((a, b) => a + b.ms, 0),

    dependents: [...new Map(blasts.flatMap((b) => b.dependents).map((d) => [d.id, d])).values()],
    nodes: [...nodes.values()],
    edges,
  };
  const targetIds = new Set(blasts.map((b) => b.params.id));
  merged.nodes = merged.nodes.map((n) => (targetIds.has(n.id) ? { ...n, role: 'target' } : n));
  merged.directCount = merged.dependents.filter((d) => d.hops === 1).length;
  merged.totalCount = merged.dependents.length;
  return merged;
}

function policyVerdict(c, blast) {
  if (c.destructive && blast.directCount > 0) {
    const names = blast.dependents.filter((d) => d.hops === 1).map((d) => d.name).join(', ');
    return { verdict: 'refuse', reason: `Destructive action on a resource with ${blast.directCount} direct dependents (${names}). Refused: no Approve.` };
  }
  if (blast.totalCount > 0) {
    return { verdict: 'caution', reason: `Non-destructive change; ${blast.totalCount} upstream dependents are exposed. Proceed only with canary + rollback.` };
  }
  return { verdict: 'safe', reason: 'Zero dependents in the graph and a restore point exists. Safe to act after human approval.' };
}

function plannerPrompt(c, blast) {
  return JSON.stringify(
    {
      detector: c.key,
      proposedAction: c.actionLabel,
      destructive: c.destructive,
      estimatedMonthlySavingsUSD: Math.round(c.monthlySavings),
      resources: c.resources.map(({ id, name, type, provider, spec, monthlyCost, owner, tags, metrics }) => ({ id, name, type, provider, spec, monthlyCost, owner, tags, metrics })),
      blastRadius: { directDependents: blast.directCount, allDependents: blast.dependents.map((d) => `${d.name} (${d.type}, ${d.hops} hop)`) },
    },
    null,
    1
  );
}

async function plan(c, blast, meter, live, emit) {
  if (live) {
    if (!meter.canSpend('planner', 4000, 900)) {
      emit('warn', `Budget cap $${meter.budget.toFixed(2)} reached: using canned plan for ${c.title}`);
    } else {
      try {
        const r = await llm.chatJSON('planner', llm.PLANNER_SYSTEM, plannerPrompt(c, blast), 900);
        meter.record('planner', r.tokensIn, r.tokensOut, r.ms, true);
        const j = r.json;
        if (!j.rationale || !Array.isArray(j.plan)) throw new Error('planner JSON missing fields');
        return { source: 'crusoe', tokensOut: r.tokensOut, ms: r.ms, data: { ...c.canned, ...j } };
      } catch (err) {
        emit('warn', `Planner call failed (${String(err.message).slice(0, 80)}); falling back to canned plan`);
      }
    }
  }
  await sleep(700);
  const u = CANNED_USAGE.planner;
  meter.record('planner', u.tokensIn, u.tokensOut, u.ms, false);
  return { source: 'canned', tokensOut: u.tokensOut, ms: u.ms, data: c.canned };
}

async function check(c, blast, planData, meter, live, emit) {
  if (live && meter.canSpend('checker', 3000, 1200)) {
    try {
      const prompt = JSON.stringify({
        action: c.actionLabel,
        destructive: c.destructive,
        resource: c.resources.map((r) => r.name),
        directDependents: blast.dependents.filter((d) => d.hops === 1).map((d) => d.name),
        indirectDependents: blast.dependents.filter((d) => d.hops > 1).map((d) => d.name),
        plan: planData.plan,
        rollback: planData.rollback,
      });
      const r = await llm.chatJSON('checker', llm.CHECKER_SYSTEM, prompt, 1200);
      meter.record('checker', r.tokensIn, r.tokensOut, r.ms, true);
      if (!RANK.hasOwnProperty(r.json.verdict)) throw new Error('bad verdict');
      return { source: 'crusoe', ...r.json };
    } catch (err) {
      emit('warn', `Checker call failed (${String(err.message).slice(0, 80)}); using policy verdict`);
    }
  }
  await sleep(350);
  const u = CANNED_USAGE.checker;
  meter.record('checker', u.tokensIn, u.tokensOut, u.ms, false);
  return { source: 'canned', ...policyVerdict(c, blast) };
}

function co2For(c) {
  const co2 = c.resources.reduce(
    (acc, r) => {
      const e = estimateSavings(r, c.action);
      return { kgSaved: acc.kgSaved + e.kgSaved, kwhSaved: acc.kwhSaved + e.kwhSaved, assumptions: acc.assumptions.length ? acc.assumptions : e.assumptions };
    },
    { kgSaved: 0, kwhSaved: 0, assumptions: [] }
  );
  co2.kgSaved = Math.round(co2.kgSaved * 10) / 10;
  co2.kwhSaved = Math.round(co2.kwhSaved);
  return co2;
}

module.exports = { detect, graphCandidate, plan, check, policyVerdict, mergeBlast, co2For, sleep, RANK };
