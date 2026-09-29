// Proof receipt: a self-contained, hash-identified record of why a fix was (or was not) made.
const crypto = require('crypto');
const { commandsFor } = require('./executor');

const cmd = (args) => (args ? `duploctl ${args.join(' ')}` : null);

function buildReceipt(f, meter) {
  const outcome = f.verdict === 'refuse' ? 'vetoed' : f.status === 'rolled-back' ? 'rolled-back' : f.status === 'executed' ? 'executed' : null;
  if (!outcome) return null;
  const c = commandsFor(f);
  const b = f.blast || {};
  const body = {
    product: 'CertAIn',
    finding: { ref: f.id, title: f.title, action: f.action, actionLabel: f.actionLabel, resources: f.resources.map((r) => ({ id: r.id, name: r.name, provider: r.provider, spec: r.spec })) },
    outcome,
    blastRadius: {
      engine: b.engine,
      directDependents: b.directCount,
      totalDependents: b.totalCount,
      dependents: (b.dependents || []).map((d) => ({ name: d.name, type: d.type, hops: d.hops })),
      cypher: b.cypher,
      params: b.params,
    },
    criticVerdict: { agent: '@SafetyCritic', verdict: f.criticSaid || 'NONE', reason: f.reason, checker: f.checker || null, bandMessageId: f.criticMsgId || null },
    dryRun: f.dryRun ? { passed: f.dryRun.passed, mode: f.dryRun.mode, checks: f.dryRun.checks.map(({ name, ok, detail }) => ({ name, ok, detail })) } : null,
    approval: f.approvedBy ? { by: f.approvedBy, at: f.approvedAt } : null,
    duplocloud: outcome === 'vetoed' ? { command: null, note: 'Vetoed: no handoff to @Executor, nothing ran.' } : { mode: f.execution?.mode, command: cmd(c.apply) || f.execution?.log?.[0]?.replace(/^\$ /, ''), log: f.execution?.log || [] },
    rollback: outcome === 'vetoed' ? null : { handle: cmd(c.rollback) || f.plan?.rollback, performed: outcome === 'rolled-back', log: f.rollback?.log || null },
    impact: { usdPerMonth: f.monthlySavings, kgCo2PerMonth: f.co2.kgSaved, kwhPerMonth: f.co2.kwhSaved, realized: outcome === 'executed', co2Assumptions: f.co2.assumptions },
    auditCost: meter ? { usd: Number(meter.spent.toFixed(4)), budgetUsd: meter.budget, tokens: meter.tokens } : null,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { receiptId: `CRT-${hash.slice(0, 8).toUpperCase()}`, sha256: hash, issuedAt: new Date().toISOString(), ...body };
}

module.exports = { buildReceipt };
