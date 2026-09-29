// CertAIn's three agents. They coordinate ONLY through the Band room (src/band.js):
//
//   @Scout         Crusoe Kimi K2.6. Finds waste, writes fix plans, asks the critic,
//                  recruits the executor after a human approves, hands off work.
//   @SafetyCritic  Crusoe Nemotron + Neo4j blast radius. Replies APPROVE or VETO per
//                  finding and runs dry runs. A VETO is final: Scout never hands off.
//   @Executor      DuploCloud. Not in the room until a human approves a fix; then
//                  Scout adds it at runtime. Executes only handoffs that cite an
//                  APPROVE from SafetyCritic, and reports back.

const { EventEmitter } = require('events');
const llm = require('./llm');
const executor = require('./executor');
const openrouter = require('./openrouter');
const { detect, graphCandidate, plan, check, policyVerdict, mergeBlast, co2For, sleep, RANK } = require('./audit');

const DESTRUCTIVE = new Set(['stop', 'delete-volume', 'decommission']);
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const refOf = (text) => (text.match(/ref:(f\d+)/) || [])[1];
const strip = (text) => text.replace(/^(\s*@\S+\s*)+/, '').trim();

class Crew extends EventEmitter {
  constructor({ env, graph, room }) {
    super();
    this.env = env;
    this.graph = graph;
    this.room = room;
    this.findings = new Map(); // Scout's working memory
    this.evidence = new Map(); // SafetyCritic's evidence board (blast radius graphs, dry-run checks)
    this.waiters = new Map();
    this.meter = new llm.Meter();
    this.running = false;

    room.join('Scout', (m) => this.onScout(m));
    room.join('SafetyCritic', (m) => this.onCritic(m));
    // Executor is deliberately NOT joined here: it is recruited at runtime.
  }

  // ---------- plumbing ----------
  waitFor(key, ms = 90000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(key);
        resolve(null);
      }, ms);
      this.waiters.set(key, (v) => {
        clearTimeout(t);
        this.waiters.delete(key);
        resolve(v);
      });
    });
  }
  resolve(key, v) {
    const w = this.waiters.get(key);
    if (w) w(v);
  }
  update(f) {
    this.findings.set(f.id, f);
    this.emit('finding', f);
  }
  meterSummary() {
    const m = this.meter.summary();
    const tin = m.byRole.reduce((a, r) => a + r.tokensIn, 0);
    const tout = m.byRole.reduce((a, r) => a + r.tokensOut, 0);
    return { ...m, frontier: openrouter.frontierCompare(tin, tout, m.spent) };
  }
  meterTick() {
    this.emit('meter', this.meterSummary());
  }

  // ---------- human-facing entry points (called by the server) ----------
  async runAudit(user = 'cto@acme.ai') {
    if (this.running) throw new Error('An audit is already running');
    this.running = true;
    this.findings.clear();
    this.evidence.clear();
    this.meter = new llm.Meter();
    this.meterTick();
    try {
      this.room.mirror({ kind: 'chat', from: 'human', user, text: `@Scout audit ${this.env.account.name}: AWS, EKS and GPU inference. Budget cap $${this.meter.budget.toFixed(2)}.`, mentions: ['Scout'] });
      return await this.scoutAudit();
    } finally {
      this.running = false;
    }
  }

  async dryRun(id) {
    const f = this.findings.get(id);
    if (!f) throw Object.assign(new Error('finding not found'), { status: 404 });
    const reply = this.waitFor(`dryrun:${id}`);
    await this.room.post('Scout', `@SafetyCritic dry-run ref:${id} target:${f.resources.map((r) => r.id).join(',')} action:${f.action}`, { mentions: ['SafetyCritic'] });
    await reply;
    return this.findings.get(id);
  }

  async approve(id, user = 'cto@acme.ai', { viaRoom = false } = {}) {
    const f = this.findings.get(id);
    if (!f) throw Object.assign(new Error('finding not found'), { status: 404 });
    if (f.criticSaid === 'APPROVE' && f.status !== 'dry-run-passed') throw Object.assign(new Error('Run a passing dry run before approving'), { status: 409 });
    if (f.status === 'executing' || f.status === 'executed') throw Object.assign(new Error('Already executing or executed'), { status: 409 });
    f.approvedVia = viaRoom ? 'band-room' : 'ui';
    if (!viaRoom) this.room.mirror({ kind: 'chat', from: 'human', user, text: `Approve ${f.actionLabel.toLowerCase()} on ${f.resources.map((r) => r.name).join(', ')} (ref:${id})`, mentions: ['Scout'] });

    // Scout's gate: it only hands off what SafetyCritic approved in the room.
    if (f.verdict === 'refuse' || f.criticSaid !== 'APPROVE') {
      await this.room.post('Scout', `@SafetyCritic vetoed ref:${id}. Not recruiting Executor; nothing will run.`, { mentions: ['SafetyCritic'], tone: 'refuse' });
      throw Object.assign(new Error('Vetoed by SafetyCritic: this resource has live dependents'), { status: 409 });
    }
    if (f.status !== 'dry-run-passed') throw Object.assign(new Error('Run a passing dry run before approving'), { status: 409 });

    f.approvedBy = user;
    f.approvedAt = new Date().toISOString();
    f.status = 'executing';
    this.update(f);

    if (!this.room.has('Executor')) {
      await this.room.thought('Scout', 'Human approval received. Looking up peers for a DuploCloud executor...', 'think');
      await this.room.recruit('Scout', 'Executor', (m) => this.onExecutor(m), 'runtime recruitment after human approval');
    }
    const done = this.waitFor(`exec:${id}`);
    await this.room.post(
      'Scout',
      `@Executor execute ref:${id} action:${f.action} target:${f.resources.map((r) => r.id).join(',')} · SafetyCritic:APPROVE (${f.criticMsgId}) · dry-run:PASSED · approved-by:${user}`,
      { mentions: ['Executor'] }
    );
    await done;
    return this.findings.get(id);
  }

  async rollback(id) {
    const f = this.findings.get(id);
    if (!f || f.status !== 'executed') throw Object.assign(new Error('Nothing to roll back'), { status: 409 });
    this.room.mirror({ kind: 'chat', from: 'human', user: f.approvedBy, text: `Roll back ref:${id}`, mentions: ['Scout'] });
    const done = this.waitFor(`rollback:${id}`);
    await this.room.post('Scout', `@Executor rollback ref:${id} action:${f.action} target:${f.resources.map((r) => r.id).join(',')}`, { mentions: ['Executor'] });
    await done;
    return this.findings.get(id);
  }

  // ---------- @Scout ----------
  async scoutAudit() {
    const live = llm.isLive();
    const P = llm.MODELS.planner;
    const C = llm.MODELS.checker;
    const think = (text, level = 'think') => this.room.thought('Scout', text, level);
    const warn = (_lvl, text) => think(text, 'warn');
    const started = Date.now();

    await think(`Loading inventory for ${this.env.account.name}: ${this.env.resources.length} resources across ${this.env.account.clouds.join(', ')}`);
    await sleep(450);
    await think(`Reasoning on Crusoe Managed Inference with ${P.label}${live ? '' : ' (demo mode: canned reasoning)'}; budget cap $${this.meter.budget.toFixed(2)}`, 'llm');
    await sleep(400);
    const candidates = detect(this.env);
    await think(`Scanned ${this.env.resources.length} resources with 7 metric detectors over ${this.env.account.lookbackDays} days: ${candidates.length} candidates`);
    await sleep(300);

    // Graph detector: the graph FINDS waste that metrics miss (no path from any live entrypoint).
    const orph = await this.graph.orphans();
    this.lastOrphans = orph;
    const orphanIds = new Set(orph.orphans.map((o) => o.id));
    const covered = new Set(candidates.flatMap((c) => c.resources.map((r) => r.id)));
    candidates.forEach((c) => {
      if (c.resources.some((r) => orphanIds.has(r.id))) c.graphConfirmed = true;
    });
    const fresh = orph.groups.filter((g) => g.every((o) => !covered.has(o.id)));
    fresh.forEach((g) => candidates.push(graphCandidate(g, this.env, orph)));
    candidates.sort((a, b) => a.priority - b.priority);
    await think(
      `${orph.engine === 'neo4j' ? 'Neo4j' : 'Graph'} orphan detection: ${orph.orphans.length} paid resources have no path from ${orph.entrypoints.length} live entrypoints. ${orph.orphans.length - fresh.flat().length} confirm metric findings; ${fresh.length ? `NEW, found only by the graph: ${fresh.map((g) => g.map((o) => o.name).join(' + ')).join('; ')}` : 'nothing new'}.`,
      'graph'
    );
    await sleep(400);

    // Planner calls run in parallel in live mode; findings are posted in priority order.
    const early = live ? candidates.map((c) => plan(c, { directCount: 0, totalCount: 0, dependents: [] }, this.meter, live, warn)) : null;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const id = `f${i + 1}`;
      const names = c.resources.map((r) => r.name).join(', ');
      await think(`${c.title}: ${names} (${c.summary})`);
      await sleep(250);
      await think(`${P.label} drafting rationale + fix plan...`, 'llm');
      const p = early ? await early[i] : await plan(c, { directCount: 0, totalCount: 0, dependents: [] }, this.meter, live, warn);
      this.meterTick();
      await think(`${P.label}: "${p.data.headline}" (${p.tokensOut} tok, ${Math.round(p.tokensOut / (p.ms / 1000))} tok/s)`, 'llm');

      const f = {
        id,
        key: c.key,
        category: c.category,
        title: c.title,
        summary: c.summary,
        action: c.action,
        actionLabel: c.actionLabel,
        destructive: c.destructive,
        monthlySavings: Math.round(c.monthlySavings),
        co2: co2For(c),
        resources: c.resources,
        foundBy: c.foundBy || 'metrics',
        graphConfirmed: Boolean(c.graphConfirmed),
        discovery: c.foundBy === 'graph' ? { engine: orph.engine, cypher: orph.cypher, entrypoints: orph.entrypoints } : null,
        plan: p.data,
        planSource: p.source,
        status: 'reviewing',
      };
      if (c.key === 'closed-model-spend') {
        // Market check with OpenRouter's live per-token prices for the same workload.
        const r = c.resources[0];
        const q = await openrouter.quoteWorkload(r.metrics.tokensPerMonthM, r.metrics.inputShare, r.currentModel);
        const crusoe = r.monthlyCost - c.monthlySavings;
        f.marketQuote = { ...q, crusoe: { model: P.id, monthly: crusoe }, current: r.monthlyCost };
        const open = q.rows.map((x) => `${x.model} ${money(x.monthly)}`).join(', ');
        await think(
          `OpenRouter ${q.source === 'live' ? 'live' : 'snapshot'} prices (${q.modelsSeen} models): ${r.metrics.tokensPerMonthM}M tok/mo${q.closed ? ` lists at ${money(q.closed.monthly)} on ${q.closed.model}` : ''}; open models ${open}. Crusoe ${P.label} target ${money(crusoe)}/mo.`,
          'tool'
        );
        f.plan = { ...f.plan, rationale: `${f.plan.rationale} Market check (OpenRouter ${q.source}): the same workload runs ${q.rows.length ? `${money(q.rows[0].monthly)}-${money(q.rows[q.rows.length - 1].monthly)}/mo` : 'far cheaper'} on open models${q.closed ? ` vs ${money(q.closed.monthly)} list on ${q.closed.model}` : ''}.` };
      }
      this.update(f);

      // Dependent handoff: Scout cannot continue on this finding until SafetyCritic answers in the room.
      const answer = this.waitFor(`review:${id}`, 60000);
      await this.room.post(
        'Scout',
        `@SafetyCritic review ref:${id} target:${c.resources.map((r) => r.id).join(',')} action:${c.action} · ${c.title}. Proposed: ${c.actionLabel}, saves ${money(c.monthlySavings)}/mo`,
        { mentions: ['SafetyCritic'], data: { ref: id } }
      );
      const verdict = await answer;
      if (!verdict) {
        f.status = 'blocked';
        f.verdict = 'refuse';
        f.reason = 'No verdict from SafetyCritic in the room. Without a critic decision nothing can be approved.';
        this.update(f);
      }
    }

    const all = [...this.findings.values()];
    const actionable = all.filter((f) => f.verdict !== 'refuse');
    // Write actionable waste back to the graph (split by resource cost) for the team rollup.
    const waste = new Map();
    for (const f of actionable) {
      const tot = f.resources.reduce((a, r) => a + (r.monthlyCost || 0), 0) || f.resources.length;
      f.resources.forEach((r) => waste.set(r.id, (waste.get(r.id) || 0) + Math.round((f.monthlySavings * (r.monthlyCost || 1)) / tot)));
    }
    await this.graph.setWaste(waste);
    this.emit('graph');
    const summary = {
      findings: all.length,
      refused: all.length - actionable.length,
      potentialMonthly: actionable.reduce((a, f) => a + f.monthlySavings, 0),
      potentialKg: Math.round(actionable.reduce((a, f) => a + f.co2.kgSaved, 0)),
      durationMs: Date.now() - started,
      meter: this.meterSummary(),
      live,
    };
    await this.room.post(
      'Scout',
      `Audit complete: ${actionable.length} fixes approved by @SafetyCritic worth ${money(summary.potentialMonthly)}/mo, ${summary.refused} vetoed. This audit cost $${summary.meter.spent.toFixed(3)} on Crusoe (cap $${this.meter.budget.toFixed(2)}).`,
      { mentions: [], tone: 'ok' }
    );
    this.emit('summary', summary);
    return summary;
  }

  onScout(m) {
    const text = strip(m.text);
    // A human participant can approve from the Band room: "@Scout approve f1".
    const human = m.from === 'human' && text.match(/^approve\s+(?:ref:)?(f\d+)\b/i);
    if (human) {
      const id = human[1];
      this.approve(id, m.user || 'band participant', { viaRoom: true }).catch((err) =>
        this.room.post('Scout', `Cannot approve ref:${id} from the room: ${err.message}.`, { mentions: [], tone: 'refuse' })
      );
      return;
    }
    const ref = refOf(text);
    const f = ref && this.findings.get(ref);
    if (!f) return;

    if (m.from === 'SafetyCritic') {
      const verb = (text.match(/^(APPROVE|VETO|DRY-RUN PASSED|DRY-RUN FAILED)/) || [])[1];
      if (verb === 'APPROVE' || verb === 'VETO') {
        const ev = this.evidence.get(ref) || {};
        f.criticSaid = verb;
        f.criticMsgId = m.id;
        f.verdict = verb === 'VETO' ? 'refuse' : ev.verdict === 'caution' ? 'caution' : 'safe';
        f.reason = text.replace(/^(APPROVE|VETO)\s+ref:f\d+\s*·?\s*/, '');
        f.blast = ev.blast;
        f.checker = ev.checker;
        f.status = verb === 'VETO' ? 'refused' : 'proposed';
        this.update(f);
        this.resolve(`review:${ref}`, verb);
      } else if (verb && verb.startsWith('DRY-RUN')) {
        const ev = this.evidence.get(ref) || {};
        f.dryRun = ev.dryRun;
        if (verb === 'DRY-RUN PASSED' && f.status === 'proposed') f.status = 'dry-run-passed';
        this.update(f);
        this.resolve(`dryrun:${ref}`, verb);
      }
    } else if (m.from === 'Executor') {
      const verb = (text.match(/^(DONE|FAILED|ROLLED-BACK|REFUSED)/) || [])[1];
      const run = this.evidence.get(`run:${ref}`);
      if (verb === 'DONE') {
        f.status = 'executed';
        f.execution = run;
        this.update(f);
        this.resolve(`exec:${ref}`, verb);
      } else if (verb === 'ROLLED-BACK') {
        f.status = 'rolled-back';
        f.rollback = run;
        this.update(f);
        this.resolve(`rollback:${ref}`, verb);
      } else if (verb) {
        f.status = verb === 'REFUSED' ? 'refused' : 'failed';
        f.execution = run;
        this.update(f);
        this.resolve(`exec:${ref}`, verb);
        this.resolve(`rollback:${ref}`, verb);
      }
    }
  }

  // ---------- @SafetyCritic ----------
  async onCritic(m) {
    if (m.from !== 'Scout') return;
    const text = strip(m.text);
    const ref = refOf(text);
    const targets = ((text.match(/target:(\S+)/) || [])[1] || '').split(',').filter(Boolean);
    const action = (text.match(/action:(\S+)/) || [])[1];
    if (!ref || !targets.length) return;
    const resources = targets.map((t) => this.graph.byId.get(t)).filter(Boolean);
    const think = (t, level = 'graph') => this.room.thought('SafetyCritic', t, level);

    if (/^review/.test(text)) {
      const blast = mergeBlast(await Promise.all(resources.map((r) => this.graph.blastRadius(r.id))));
      await think(
        `Blast radius via ${blast.engine === 'neo4j' ? 'Neo4j Cypher' : 'graph traversal'} on ${resources.map((r) => r.name).join(', ')}: ${blast.directCount} direct / ${blast.totalCount} total dependents${blast.directCount ? ': ' + blast.dependents.filter((d) => d.hops === 1).map((d) => d.name).join(', ') : ''}`
      );
      const c = { destructive: DESTRUCTIVE.has(action), actionLabel: action, resources, title: resources[0]?.name };
      const scoutPlan = this.findings.get(ref)?.plan || {};
      await think(`${llm.MODELS.checker.label} validating safety...`, 'llm');
      const chk = await check(c, blast, scoutPlan, this.meter, llm.isLive(), (_l, t) => think(t, 'warn'));
      this.meterTick();
      const pol = policyVerdict(c, blast);
      // The deterministic policy is authoritative for vetoes; the LLM may only add caution.
      let verdict = pol.verdict;
      let reason = pol.reason;
      if (pol.verdict !== 'refuse' && RANK[chk.verdict] > RANK[pol.verdict]) {
        verdict = 'caution';
        reason = chk.reason;
      } else if (chk.source === 'crusoe' && chk.reason && pol.verdict !== 'refuse') {
        reason = chk.reason;
      }
      this.evidence.set(ref, { blast, checker: { verdict: chk.verdict, reason: chk.reason, source: chk.source }, verdict });

      if (verdict === 'refuse') {
        const deps = blast.dependents.filter((d) => d.hops === 1).map((d) => d.name);
        await this.room.post(
          'SafetyCritic',
          `@Scout VETO ref:${ref} · ${deps.length} services depend on ${resources.map((r) => r.name).join(', ')} (${deps.join(', ')}). A ${action} would break them. Blocked: no handoff to Executor.`,
          { mentions: ['Scout'], tone: 'refuse' }
        );
      } else {
        const n = blast.totalCount;
        const head = n === 0 ? '0 dependents in the graph.' : `${n} upstream dependent${n === 1 ? '' : 's'}; change is non-destructive.`;
        const tail = verdict === 'caution' ? 'Conditions: canary + rollback armed.' : 'Restore point required; safe after human approval.';
        const extra = chk.source === 'crusoe' && chk.reason ? ` Nemotron: ${chk.reason}` : '';
        await this.room.post('SafetyCritic', `@Scout APPROVE ref:${ref} · ${head} ${tail}${extra}`, { mentions: ['Scout'], tone: verdict === 'caution' ? 'warn' : 'ok' });
      }
    } else if (/^dry-run/.test(text)) {
      const f = this.findings.get(ref);
      const ev = this.evidence.get(ref) || {};
      await think(`Dry run for ref:${ref}: DuploCloud lookup, snapshot, rollback plan`, 'think');
      const res = await executor.dryRun({ ...f, blast: ev.blast, verdict: ev.verdict });
      await sleep(600);
      this.evidence.set(ref, { ...ev, dryRun: res });
      const snap = res.checks.find((c) => /Snapshot|Config|Restore/.test(c.name));
      await this.room.post(
        'SafetyCritic',
        `@Scout DRY-RUN ${res.passed ? 'PASSED' : 'FAILED'} ref:${ref} · ${res.checks.filter((c) => c.ok).length}/${res.checks.length} checks green · ${snap ? `${snap.name.toLowerCase()}: ${snap.detail.replace(/ \(.*\)$/, '')}` : ''} · rollback ready`,
        { mentions: ['Scout'], tone: res.passed ? 'ok' : 'refuse' }
      );
    }
  }

  // ---------- @Executor ----------
  async onExecutor(m) {
    if (m.from !== 'Scout') return;
    const text = strip(m.text);
    const ref = refOf(text);
    const f = ref && this.findings.get(ref);
    if (!f) return;
    const think = (t) => this.room.thought('Executor', t, 'exec');

    if (/^execute/.test(text)) {
      // Executor trusts the room, not Scout's say-so: the handoff must cite a critic APPROVE.
      if (!/SafetyCritic:APPROVE/.test(text) || f.criticSaid !== 'APPROVE') {
        await this.room.post('Executor', `@Scout REFUSED ref:${ref} · handoff has no SafetyCritic APPROVE. Not executing.`, { mentions: ['Scout'], tone: 'refuse' });
        return;
      }
      await think(`Executing ref:${ref} through DuploCloud (${executor.isLive() ? 'duploctl' : 'simulated tenant'})`);
      const run = await executor.apply(f);
      for (const line of run.log) {
        await this.room.thought('Executor', line, 'exec');
        await sleep(280);
      }
      this.evidence.set(`run:${ref}`, run);
      await this.room.post(
        'Executor',
        run.ok
          ? `@Scout DONE ref:${ref} · ${f.actionLabel.toLowerCase()} on ${f.resources.map((r) => r.name).join(', ')} via DuploCloud. Saving ${money(f.monthlySavings)}/mo and ${f.co2.kgSaved} kg CO2/mo. Rollback is one click.`
          : `@Scout FAILED ref:${ref} · DuploCloud returned an error; nothing changed.`,
        { mentions: ['Scout'], tone: run.ok ? 'ok' : 'refuse' }
      );
    } else if (/^rollback/.test(text)) {
      const run = await executor.rollback(f);
      for (const line of run.log) {
        await this.room.thought('Executor', line, 'exec');
        await sleep(250);
      }
      this.evidence.set(`run:${ref}`, run);
      await this.room.post('Executor', run.ok ? `@Scout ROLLED-BACK ref:${ref} · ${f.resources.map((r) => r.name).join(', ')} restored.` : `@Scout FAILED ref:${ref} · rollback error`, {
        mentions: ['Scout'],
        tone: run.ok ? 'warn' : 'refuse',
      });
    }
  }
}

module.exports = { Crew };
