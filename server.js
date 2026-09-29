// CertAIn: cloud and AI savings you can be certain of.
const path = require('path');
const express = require('express');

const env = require('./data/acme-env.json');
const { ResourceGraph, QUERIES } = require('./src/graph');
const { Room } = require('./src/band');
const { Crew } = require('./src/agents');
const executor = require('./src/executor');
const llm = require('./src/llm');
const { ASSUMPTIONS } = require('./src/co2');
const openrouter = require('./src/openrouter');
const { buildReceipt } = require('./src/receipt');
const { analyzeBill } = require('./src/bill');
const fs = require('fs');

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/cytoscape.min.js', (req, res) => res.sendFile(require.resolve('cytoscape/dist/cytoscape.min.js')));

const graph = new ResourceGraph(env);
let room;
let crew;
let lastSummary = null;
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(payload));
}

function totals() {
  const done = crew ? [...crew.findings.values()].filter((f) => f.status === 'executed') : [];
  return {
    savedMonthly: done.reduce((a, f) => a + f.monthlySavings, 0),
    savedKg: Math.round(done.reduce((a, f) => a + f.co2.kgSaved, 0) * 10) / 10,
    executed: done.length,
  };
}

function config() {
  return {
    product: 'CertAIn',
    account: env.account,
    llm: { live: llm.isLive(), baseURL: llm.CRUSOE_BASE_URL, planner: llm.MODELS.planner, checker: llm.MODELS.checker, budget: llm.BUDGET_USD },
    graph: { engine: graph.engine, status: graph.status },
    executor: { mode: executor.isLive() ? 'duploctl' : 'simulated', tenant: process.env.DUPLO_TENANT || null },
    band: { mode: room.mode, label: room.transport.label, participants: [...room.participants] },
    co2Assumptions: ASSUMPTIONS,
    integrations: integrations(),
  };
}

// LIVE vs SIMULATED per sponsor integration, shown as a strip in the UI.
function integrations() {
  const m = crew ? crew.meter.summary() : { liveCalls: 0 };
  const or = openrouter.status();
  return [
    {
      name: 'Crusoe',
      role: 'Kimi K2.6 + Nemotron reasoning',
      live: llm.isLive() && (m.calls === 0 || m.liveCalls > 0),
      detail: !llm.isLive() ? 'no CRUSOE_API_KEY: canned reasoning' : m.calls && !m.liveCalls ? 'key set but every call failed: canned fallback (see server log)' : `${llm.CRUSOE_BASE_URL} · ${m.liveCalls} live calls this audit`,
    },
    { name: 'Neo4j', role: 'blast-radius graph', live: graph.engine === 'neo4j', detail: graph.status },
    { name: 'Band', role: 'agent room', live: room.mode === 'band', detail: room.transport.label },
    { name: 'DuploCloud', role: 'execution + rollback', live: executor.isLive(), detail: executor.isLive() ? `duploctl · tenant ${process.env.DUPLO_TENANT}` : 'no DUPLO_* env: simulated tenant' },
    { name: 'OpenRouter', role: 'live model pricing', live: or.source === 'live', detail: or.source === 'live' ? `${or.count} models fetched ${or.fetchedAt}` : `bundled snapshot${or.error ? ` (${or.error})` : ''}` },
  ];
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json(config()));
app.get('/api/integrations', (req, res) => res.json(integrations()));
// Graph tab: the full resource graph plus every query the agents run, with results.
app.get('/api/graph', async (req, res) => {
  const [orphans, teams] = await Promise.all([graph.orphans(), graph.teamRollup()]);
  const vetoed = crew ? [...crew.findings.values()].filter((f) => f.verdict === 'refuse').flatMap((f) => f.resources.map((r) => r.id)) : [];
  const flagged = crew ? [...crew.findings.values()].filter((f) => f.verdict !== 'refuse').flatMap((f) => f.resources.map((r) => r.id)) : [];
  res.json({
    engine: graph.engine,
    status: graph.status,
    ...graph.full(),
    flagged,
    vetoed,
    orphans,
    teams,
    queries: [
      { name: 'Orphan detection (Scout detector)', cypher: QUERIES.orphans, engine: orphans.engine, ms: orphans.ms, result: `${orphans.orphans.length} orphans in ${orphans.groups.length} groups: ${orphans.groups.map((g) => g.map((o) => o.name).join(' + ')).join('; ')}` },
      { name: 'Blast radius (SafetyCritic gate)', cypher: QUERIES.blastRadius, engine: graph.engine, result: 'Run per finding; variable-length DEPENDS_ON*1..5, returns direct and transitive dependents with hop counts' },
      { name: 'Team rollup', cypher: QUERIES.teamRollup, engine: teams.engine, ms: teams.ms, result: teams.rows.map((r) => `${r.team} $${Math.round(r.waste).toLocaleString()} waste / $${Math.round(r.spend).toLocaleString()} spend`).join(' · ') },
      { name: 'Waste write-back', cypher: QUERIES.setWaste, engine: graph.engine, result: 'Runs after each audit so the rollup reflects actionable waste' },
    ],
  });
});

app.get('/api/environment', (req, res) => res.json(env));
app.get('/api/state', (req, res) =>
  res.json({ findings: [...crew.findings.values()], summary: lastSummary, totals: totals(), room: room.history, participants: [...room.participants], meter: crew.meterSummary(), running: crew.running })
);

// One Server-Sent Events stream for everything live: room messages, findings, meter, totals.
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ participants: [...room.participants] })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

const wrap = (fn) => async (req, res) => {
  try {
    const finding = await fn(req);
    res.json({ finding, totals: totals() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, finding: crew.findings.get(req.params.id) });
  }
};

app.post('/api/audit', (req, res) => {
  if (crew.running) return res.status(409).json({ error: 'An audit is already running' });
  lastSummary = null;
  crew.runAudit((req.body && req.body.user) || 'cto@acme.ai').catch((err) => broadcast('error', { message: err.message }));
  res.status(202).json({ ok: true });
});
app.post('/api/findings/:id/dryrun', wrap((req) => crew.dryRun(req.params.id)));
app.post('/api/findings/:id/approve', wrap((req) => crew.approve(req.params.id, (req.body && req.body.user) || 'cto@acme.ai')));
app.post('/api/findings/:id/rollback', wrap((req) => crew.rollback(req.params.id)));

app.get('/api/findings/:id/receipt', (req, res) => {
  const f = crew.findings.get(req.params.id);
  const r = f && buildReceipt(f, crew.meter.summary());
  if (!r) return res.status(404).json({ error: 'No receipt: finding must be executed, rolled back or vetoed' });
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="certain-receipt-${r.receiptId}.json"`);
  res.json(r);
});

// Simulate a human participant typing "@Scout approve f1" in the room (in-process mode).
// With a real Band room, type the same message in app.band.ai instead.
app.post('/api/band/human-approve', async (req, res) => {
  const id = req.body && req.body.id;
  const user = (req.body && req.body.user) || 'judge@hackersquad';
  if (!crew.findings.get(id)) return res.status(404).json({ error: 'finding not found' });
  if (room.mode === 'band') return res.status(409).json({ error: `Type "@Scout approve ${id}" in the Band room` });
  await room.post('human', `@Scout approve ${id}`, { mentions: ['Scout'], user });
  res.status(202).json({ ok: true });
});

// "Try it on your bill": parsed in this process; raw rows are never sent anywhere.
app.get('/api/bill/sample', (req, res) => res.type('text/csv').send(fs.readFileSync(path.join(__dirname, 'data', 'sample-bill.csv'), 'utf8')));
app.post('/api/bill/analyze', async (req, res) => {
  try {
    const csv = req.body && req.body.csv;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'Send {csv: "<file contents>"}' });
    const name = String((req.body && req.body.name) || 'bill.csv').slice(0, 80);
    const r = await analyzeBill(csv, { env, source: name });
    room.post(
      'Scout',
      `Analyzed ${name} locally: ${r.lineItems} line items, $${Math.round(r.totalMonthly).toLocaleString()}/mo bill, $${r.wasteMonthly.toLocaleString()}/mo (${r.wastePct}%) looks like waste. Top: ${r.top.slice(0, 3).map((f) => `${f.title.toLowerCase()} $${f.savings.toLocaleString()}`).join(', ')}. Raw rows stayed on this machine.`,
      { mentions: [], tone: 'ok' }
    );
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/reset', (req, res) => {
  if (crew.running) return res.status(409).json({ error: 'Audit running' });
  crew.findings.clear();
  crew.evidence.clear();
  room.reset();
  room.dismiss('Scout', 'Executor');
  graph.setWaste(new Map());
  lastSummary = null;
  broadcast('reset', {});
  res.json({ ok: true });
});

async function main() {
  await Promise.all([graph.init(), openrouter.getModels()]);
  room = await new Room().start();
  room.on('message', (m) => broadcast('room', m));
  crew = new Crew({ env, graph, room });
  crew.on('finding', (f) => broadcast('finding', f));
  crew.on('meter', (m) => broadcast('meter', m));
  crew.on('graph', () => broadcast('graph', {}));
  crew.on('summary', (s) => {
    broadcast('integrations', integrations());
    lastSummary = s;
    broadcast('summary', { summary: s, totals: totals() });
  });
  crew.on('finding', (f) => {
    if (f.status === 'executed' || f.status === 'rolled-back') broadcast('totals', totals());
  });

  app.listen(PORT, () => {
    console.log(`\n  CertAIn running at http://localhost:${PORT}`);
    console.log(`  LLM:      ${llm.isLive() ? `Crusoe Managed Inference (live): ${llm.MODELS.planner.id} + ${llm.MODELS.checker.id}` : 'demo mode (canned reasoning; set CRUSOE_API_KEY for live)'}`);
    console.log(`  Graph:    ${graph.status}`);
    console.log(`  Band:     ${room.transport.label}`);
    console.log(`  Executor: ${executor.isLive() ? 'duploctl (live DuploCloud tenant)' : 'simulated DuploCloud'}`);
    console.log(`  Pricing:  OpenRouter ${openrouter.status().source}\n`);
  });
}

main();
