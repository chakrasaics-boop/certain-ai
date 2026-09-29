// Smoke-test every sponsor integration with the current env. Usage: npm run check
const { execFile } = require('child_process');
const ok = (name, msg) => console.log(`  LIVE  ${name.padEnd(11)} ${msg}`);
const sim = (name, msg) => console.log(`  SIM   ${name.padEnd(11)} ${msg}`);
const bad = (name, msg) => console.log(`  FAIL  ${name.padEnd(11)} ${msg}`);

(async () => {
  console.log('CertAIn integration check\n');
  const llm = require('../src/llm');
  if (!process.env.CRUSOE_API_KEY) sim('Crusoe', 'CRUSOE_API_KEY not set: canned reasoning');
  else {
    try {
      const r = await llm.chatJSON('checker', 'Reply with only JSON.', 'Return {"verdict":"safe","reason":"ping"}', 300);
      ok('Crusoe', `${llm.MODELS.checker.id} answered in ${r.ms} ms (${r.tokensIn}+${r.tokensOut} tokens)`);
    } catch (e) {
      bad('Crusoe', e.message);
    }
  }

  const { ResourceGraph } = require('../src/graph');
  const g = await new ResourceGraph(require('../data/acme-env.json')).init();
  if (g.engine === 'neo4j') {
    const b = await g.blastRadius('rds-legacy-billing');
    ok('Neo4j', `${g.status}; rds-legacy-billing has ${b.directCount} direct dependents`);
  } else (process.env.NEO4J_URI ? bad : sim)('Neo4j', g.status);
  await g.close();

  const { bandConfig } = require('../src/band');
  const bc = bandConfig();
  if (!bc.enabled) sim('Band', 'BAND_ROOM_ID + BAND_{SCOUT,SAFETY_CRITIC,EXECUTOR}_{API_KEY,ID} not all set: in-process room');
  else {
    try {
      const r = await fetch(`${bc.baseURL}/api/v1/agent/me`, { headers: { 'X-API-Key': bc.agents.Scout.apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ok('Band', `Scout authenticated; room ${bc.roomId}`);
    } catch (e) {
      bad('Band', e.message);
    }
  }

  const ex = require('../src/executor');
  if (!ex.isLive()) sim('DuploCloud', 'DUPLO_HOST/DUPLO_TOKEN/DUPLO_TENANT not set: simulated tenant');
  else
    await new Promise((res) =>
      execFile(process.env.DUPLOCTL_BIN || 'duploctl', ['tenant', 'find', process.env.DUPLO_TENANT], { env: process.env, timeout: 30000 }, (err, out, errOut) => {
        err ? bad('DuploCloud', (errOut || err.message).trim().slice(0, 200)) : ok('DuploCloud', `duploctl reached tenant ${process.env.DUPLO_TENANT}`);
        res();
      })
    );

  const or = require('../src/openrouter');
  await or.getModels();
  const s = or.status();
  s.source === 'live' ? ok('OpenRouter', `${s.count} models with live pricing`) : bad('OpenRouter', `live fetch failed (${s.error}); bundled snapshot in use`);
})();
