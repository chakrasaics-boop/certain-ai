// GET /v1/models on Crusoe Managed Inference. Usage: CRUSOE_API_KEY=... npm run models
const base = process.env.CRUSOE_BASE_URL || 'https://api.inference.crusoecloud.com/v1';
const key = process.env.CRUSOE_API_KEY;
if (!key) {
  console.error('Set CRUSOE_API_KEY first (Crusoe console -> Intelligence Foundry -> Models -> Get API Key).');
  process.exit(1);
}
fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
  .then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
    const ids = (body.data || []).map((m) => m.id).sort();
    console.log(`${ids.length} models on ${base}:\n  ${ids.join('\n  ')}`);
    for (const [envName, def] of [['PLANNER_MODEL', 'moonshotai/Kimi-K2.6'], ['CHECKER_MODEL', 'nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B']]) {
      const want = process.env[envName] || def;
      console.log(`${envName}=${want} ${ids.includes(want) ? 'OK' : 'NOT FOUND: set ' + envName + ' to one of the ids above'}`);
    }
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
