/* CertAIn front end: plain JS, one SSE stream, no build step. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const kg = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString('en-US');

  const S = {
    config: null,
    findings: new Map(),
    order: [],
    selected: null,
    totals: { savedMonthly: 0, savedKg: 0, executed: 0 },
    summary: null,
    participants: new Set(),
    busy: {},
    shown: { money: 0, kg: 0 },
  };
  let cy = null;
  let cyFor = null;

  // ---------- helpers ----------
  async function api(path, method = 'GET', body) {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
    return data;
  }

  function tween(el, from, to, fmt, ms = 900) {
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function bump(sel) {
    const el = $(sel);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // ---------- integrations + config ----------
  function renderIntegrations(list) {
    $('#integrations').innerHTML = list
      .map(
        (i) => `<span class="integ ${i.live ? 'live' : 'sim'}"><b>${esc(i.name)}</b>${esc(i.role)}<span class="state">${i.live ? 'LIVE' : 'SIMULATED'}</span>
          <span class="tip">${esc(i.detail)}</span></span>`
      )
      .join('');
  }

  function renderConfig(c) {
    S.config = c;
    $('#account').innerHTML = `<b>${esc(c.account.name)}</b> · ${esc(c.account.stage)} · ${money(c.account.monthlyBill)}/mo cloud bill`;
    renderIntegrations(c.integrations);
    const a = c.co2Assumptions;
    $('#co2Tip').innerHTML = `CO2e = energy (kWh) x PUE x grid carbon intensity.<ul>
      <li>PUE ${a.pue.value} (${esc(a.pue.source)})</li>
      <li>us-east-1 grid ${a.grid['us-east-1'].value} kg/kWh (${esc(a.grid['us-east-1'].source)})</li>
      <li>Crusoe ${a.grid.crusoe.value} kg/kWh (${esc(a.grid.crusoe.source)})</li>
      <li>SSD ${a.ssdWhPerTBh.value} Wh/TB-h x replication ${a.ebsReplication.value}</li>
      <li>LLM ${a.closedModelWhPer1kTok.value} Wh/1k tok closed vs ${a.openModelWhPer1kTok.value} open MoE</li></ul>`;
    $('#costSub').textContent = `Hard budget cap $${c.llm.budget.toFixed(2)} · ${c.llm.live ? 'live Crusoe' : 'demo mode'}`;
    $('#footMode').textContent = `Planner ${c.llm.planner.id} · Checker ${c.llm.checker.id} · ${c.llm.baseURL}${c.llm.live ? '' : ' · demo mode: canned reasoning, simulated token accounting'}`;
  }

  // ---------- counters ----------
  function renderMeter(m) {
    if (!m) return;
    $('#auditCost').textContent = '$' + (m.spent >= 0.0095 ? m.spent.toFixed(2) : m.spent.toFixed(3));
    $('#budgetBar').style.width = Math.min(100, (m.spent / m.budget) * 100) + '%';
    $('#costSub').textContent = `${Math.round((m.spent / m.budget) * 100)}% of $${m.budget.toFixed(2)} hard cap · ${m.tokens.toLocaleString()} tokens · ${m.calls} calls${m.liveCalls ? '' : ' (simulated)'}`;
    $('#tps').textContent = m.tokensPerSec ? `${m.tokensPerSec} tok/s` : '-- tok/s';
    const fr = m.frontier;
    $('#costMult').hidden = !fr;
    if (fr) {
      const x = fr.multiple >= 10 ? Math.round(fr.multiple) : fr.multiple.toFixed(1);
      $('#multText').textContent = `${x}× cheaper than ${fr.model}`;
      $('#multTip').innerHTML = `Same audit tokens priced at ${esc(fr.model)} list price (OpenRouter ${fr.source === 'live' ? 'live' : 'snapshot'}):<ul>
        <li><code>${fr.tokensIn.toLocaleString()} in × $${fr.priceIn.toFixed(2)}/M + ${fr.tokensOut.toLocaleString()} out × $${fr.priceOut.toFixed(2)}/M = $${fr.cost.toFixed(3)}</code></li>
        <li>This audit on Crusoe: <code>$${fr.spent.toFixed(3)}</code>${m.liveCalls ? '' : ' (simulated tokens)'}</li>
        <li><code>$${fr.cost.toFixed(3)} / $${fr.spent.toFixed(3)} = ${fr.multiple.toFixed(1)}×</code></li></ul>`;
    }
  }

  function renderTotals(t) {
    if (!t) return;
    const prev = S.shown;
    if (t.savedMonthly !== prev.money) {
      tween($('#savedMoney'), prev.money, t.savedMonthly, money);
      if (t.savedMonthly > prev.money) bump('.hero-money-box');
    }
    if (t.savedKg !== prev.kg) {
      tween($('#savedCo2'), prev.kg, t.savedKg, kg);
      if (t.savedKg > prev.kg) bump('.counter.co2');
    }
    S.shown = { money: t.savedMonthly, kg: t.savedKg };
    S.totals = t;
    $('#savedSub').textContent = t.executed ? `${t.executed} fix${t.executed > 1 ? 'es' : ''} executed via DuploCloud` : S.summary ? `Potential ${money(S.summary.potentialMonthly)}/mo found` : 'Run an audit to find waste';
    const potKg = [...S.findings.values()].filter((f) => f.verdict && f.verdict !== 'refuse').reduce((a, f) => a + f.co2.kgSaved, 0);
    $('#co2Sub').textContent = potKg ? `of ${kg(potKg)} kg CO2e/mo available` : 'CO2e, same card as the dollars';
  }

  function renderFoundCounter() {
    const all = [...S.findings.values()];
    const refused = all.filter((f) => f.verdict === 'refuse').length;
    const pot = all.filter((f) => f.verdict && f.verdict !== 'refuse').reduce((a, f) => a + f.monthlySavings, 0);
    $('#foundMoney').innerHTML = `${money(pot)}<small>/mo</small>`;
    $('#foundSub').textContent = all.length ? `${all.length} findings · ${all.length - refused} safe to fix · ${refused} vetoed` : '0 findings';
    $('#findingsMeta').textContent = all.length ? `${all.length} · ${money(pot)}/mo` : '';
    if (!S.totals.executed) $('#savedSub').textContent = all.length ? `Potential ${money(pot)}/mo found` : 'Run an audit to find waste';
  }

  // ---------- Band room ----------
  const AV = { Scout: 'S', SafetyCritic: 'C', Executor: 'E', human: 'H', band: 'B' };
  function renderMembers(newbie) {
    $('#members').innerHTML = ['human', 'Scout', 'SafetyCritic', 'Executor']
      .map((m) => {
        const inRoom = m === 'human' || S.participants.has(m);
        const label = m === 'human' ? 'cto@acme.ai' : '@' + m;
        const role = { Scout: 'Kimi K2.6', SafetyCritic: 'Nemotron + Neo4j', Executor: 'DuploCloud', human: 'human' }[m];
        return `<span class="member ${inRoom ? '' : 'absent'} ${newbie === m ? 'new' : ''}" title="${esc(role)}${inRoom ? '' : ' (not in room yet)'}"><span class="av ${m}">${AV[m]}</span>${esc(label)}</span>`;
      })
      .join('');
  }

  function fmtText(t) {
    let h = esc(t);
    h = h.replace(/@(Scout|SafetyCritic|Executor)\b/g, '<span class="mention">@$1</span>');
    h = h.replace(/\b(APPROVE|VETO|DONE|REFUSED|FAILED|ROLLED-BACK)\b/g, '<span class="verb $1">$1</span>');
    h = h.replace(/DRY-RUN (PASSED|FAILED)/g, 'DRY-RUN <span class="verb $1">$1</span>');
    h = h.replace(/ref:(f\d+)/g, '<span class="ref">ref:$1</span>');
    return h;
  }

  function addRoom(m) {
    const room = $('#room');
    const empty = room.querySelector('.empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (m.kind === 'event') {
      li.className = `ev ${m.level || ''}`;
      li.innerHTML = `<span class="src">${esc(m.from)} ›</span> ${esc(m.text)}`;
    } else if (m.kind === 'system') {
      li.className = 'sys';
      li.innerHTML = m.recruit ? `— ${esc(m.text.split(' added ')[0])} added <b>@${esc(m.recruit)}</b> to the room · runtime recruitment —` : `— ${esc(m.text)} —`;
      const joined = m.recruit || (m.text.match(/^(\w+) joined/) || [])[1];
      if (joined) {
        S.participants.add(joined);
        renderMembers(m.recruit);
      }
    } else {
      li.className = `msg ${m.from === 'human' ? 'human' : ''} ${m.tone ? 'tone-' + m.tone : ''}`;
      const who = m.from === 'human' ? m.user || 'cto@acme.ai' : '@' + m.from;
      li.innerHTML = `<span class="av ${esc(m.from)}">${AV[m.from] || '?'}</span><div><div class="who">${esc(who)}<span class="t">${time}</span></div><div class="bubble">${fmtText(m.text)}</div></div>`;
    }
    room.appendChild(li);
    room.scrollTop = room.scrollHeight;
  }

  // ---------- findings list ----------
  function badgeFor(f) {
    if (f.status === 'executed') return '<span class="badge executed">Executed</span>';
    if (f.status === 'rolled-back') return '<span class="badge rolled">Rolled back</span>';
    if (f.status === 'reviewing') return '<span class="badge reviewing">In review</span>';
    if (f.verdict === 'refuse') return '<span class="badge refuse">Vetoed</span>';
    if (f.verdict === 'caution') return '<span class="badge caution">Approved · canary</span>';
    return '<span class="badge safe">Approved</span>';
  }

  function renderList() {
    const box = $('#findings');
    if (!S.order.length) {
      box.innerHTML = `<div class="empty-state"><p>No audit yet.</p><p class="muted">Click <b>Run audit</b> to scan Acme AI's AWS, Kubernetes and GPU inference spend.</p></div>`;
      return;
    }
    box.innerHTML = S.order
      .map((id) => {
        const f = S.findings.get(id);
        return `<div class="fcard ${f.verdict === 'refuse' ? 'refused' : ''} ${S.selected === id ? 'active' : ''}" data-id="${id}" tabindex="0">
          <div class="row"><span class="cat">${esc(f.category)}</span>${f.foundBy === 'graph' ? '<span class="chip graph">Found by graph</span>' : f.graphConfirmed ? '<span class="chip gconf">Graph-confirmed</span>' : ''}${badgeFor(f)}</div>
          <div class="title">${esc(f.title)}</div>
          <div class="res">${esc(f.resources.map((r) => r.name).join(', '))}</div>
          <div class="sum">${esc(f.summary)}</div>
          <div class="nums"><span class="m">${money(f.monthlySavings)}/mo</span><span class="c">${kg(f.co2.kgSaved)} kg CO2/mo</span></div>
        </div>`;
      })
      .join('');
  }

  $('#findings').addEventListener('click', (e) => {
    const card = e.target.closest('.fcard');
    if (card) select(card.dataset.id);
  });
  $('#findings').addEventListener('keydown', (e) => {
    const card = e.target.closest('.fcard');
    if (card && (e.key === 'Enter' || e.key === ' ')) select(card.dataset.id);
  });

  function select(id) {
    if ($('#auditView').hidden) setTab('audit');
    S.selected = id;
    renderList();
    renderDetail(true);
  }

  // ---------- detail ----------
  function gates(f) {
    const g1 = f.verdict === 'refuse' ? 'bad' : f.blast ? 'ok' : 'now';
    const g2 = f.verdict === 'refuse' ? '' : f.dryRun ? (f.dryRun.passed ? 'ok' : 'bad') : f.blast ? 'now' : '';
    const g3 = f.approvedBy ? 'ok' : f.status === 'dry-run-passed' ? 'now' : '';
    const g4 = f.status === 'executed' ? 'ok' : f.status === 'rolled-back' ? 'ok' : f.status === 'executing' ? 'now' : '';
    const item = (cls, n, label) => `<div class="gate ${cls}"><span class="n">${cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : n}</span>${label}</div>`;
    return `<div class="gates">${item(g1, 1, 'Blast radius')}${item(g2, 2, 'Dry run')}${item(g3, 3, 'Human approval')}${item(g4, 4, f.status === 'rolled-back' ? 'Rolled back' : 'DuploCloud')}</div>`;
  }

  function blastSide(f) {
    const b = f.blast;
    if (!b) return `<div class="lbl">SafetyCritic is querying the graph...</div>`;
    const direct = b.dependents.filter((d) => d.hops === 1);
    const cls = f.verdict === 'refuse' ? 'bad' : b.totalCount ? 'some' : 'zero';
    const n = f.verdict === 'refuse' ? direct.length : b.totalCount;
    const label = f.verdict === 'refuse' ? `services depend on it. A ${f.action} would break them.` : b.totalCount ? 'upstream dependents; change is non-destructive' : 'dependents. No services, no DNS, no jobs.';
    return `<div class="blast-count ${cls}">${n}</div><div class="lbl">${label}</div>
      ${b.totalCount ? `<div class="lbl">${direct.length} direct · ${b.totalCount - direct.length} transitive (DEPENDS_ON*1..5)</div><ul class="deps">${b.dependents
        .slice()
        .sort((x, y) => x.hops - y.hops)
        .map((d) => `<li class="d${d.hops}"><span class="h">${d.hops} hop${d.hops > 1 ? 's' : ''}</span>${esc(d.name)}</li>`)
        .join('')}</ul>` : ''}
      <div class="legend"><span><i style="background:${f.verdict === 'refuse' ? '#ff5f6d' : '#3ddc97'}"></i>target</span><span><i style="background:#ff5f6d"></i>direct</span><span><i style="background:#f5b84b"></i>indirect</span><span><i style="background:#5d6b7c"></i>depends on</span></div>`;
  }

  function planCard(f) {
    const p = f.plan || {};
    const q = f.marketQuote;
    const quote = q
      ? `<table class="quote">
          <tr class="closed"><td>Current: closed model (${esc(q.closed ? q.closed.model : 'frontier')})</td><td>${money(q.current)}/mo</td></tr>
          ${q.rows.map((r) => `<tr><td>${esc(r.model)} <span class="muted">(OpenRouter)</span></td><td>${money(r.monthly)}/mo</td></tr>`).join('')}
          <tr class="crusoe"><td>Target: ${esc(q.crusoe.model)} on Crusoe</td><td>${money(q.crusoe.monthly)}/mo</td></tr>
        </table>
        <div class="quote-src">Same ${q.tokensM}M tokens/mo at ${Math.round(q.inputShare * 100)}% input. OpenRouter prices: ${q.source === 'live' ? `live, ${q.modelsSeen} models` : 'bundled snapshot (live fetch unavailable)'}.</div>`
      : '';
    return `<div class="card"><div class="card-h">@Scout's plan<span class="src">${f.planSource === 'crusoe' ? 'Kimi K2.6 on Crusoe · live' : 'Kimi K2.6 · canned (demo mode)'}</span></div>
      <div class="card-b"><div class="headline">${esc(p.headline)}</div><p class="rationale">${esc(p.rationale)}</p>
      <ol class="plan">${(p.plan || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <div class="muted" style="margin-top:8px;font-size:12.5px"><b style="color:var(--text)">Rollback:</b> ${esc(p.rollback)}</div>${quote}</div></div>`;
  }

  function checksHTML(dr) {
    return `<ul class="checks">${dr.checks
      .map((c, i) => `<li class="${c.ok ? 'ok' : 'bad'}" style="animation-delay:${i * 220}ms"><span class="ic">${c.ok ? '✓' : '✕'}</span><span class="nm">${esc(c.name)}</span><span class="dt" title="${esc(c.detail)}">${esc(c.detail)}</span></li>`)
      .join('')}</ul>`;
  }

  function actionsHTML(f) {
    if (f.status === 'reviewing' || !f.criticSaid) return `<div class="actions"><span class="hint">Waiting for @SafetyCritic's verdict in the Band room...</span></div>`;
    if (f.verdict === 'refuse') {
      return `<div class="refusal"><h4>✕ Vetoed by @SafetyCritic. No Approve button.</h4><p>${esc(f.reason)}</p>
        <div class="alt">Safer alternative from @Scout: ${esc((f.plan.plan || []).slice(1).join(' · '))}</div></div>`;
    }
    const parts = [];
    if (f.dryRun) parts.push(`<div class="card"><div class="card-h">Dry run<span class="src">${f.dryRun.mode === 'duploctl' ? 'duploctl · live' : 'DuploCloud · simulated'}</span></div><div class="card-b">${checksHTML(f.dryRun)}</div></div>`);
    const run = f.status === 'rolled-back' ? f.rollback : f.execution;
    if (run) parts.push(`<div class="term" id="term">${run.log.map((l) => `<div class="${l.startsWith('$') ? 'cmd' : ''}">${esc(l)}</div>`).join('')}</div>`);

    if (f.status === 'executed') {
      parts.push(`<div class="done-banner"><div>Executed by <b>@Executor</b> via DuploCloud after approval by ${esc(f.approvedBy)}. Saving <b>${money(f.monthlySavings)}/mo</b> and <b style="color:var(--teal)">${kg(f.co2.kgSaved)} kg CO2/mo</b>.</div>
        <button class="btn danger" data-act="rollback" ${S.busy[f.id] ? 'disabled' : ''}>${S.busy[f.id] === 'rollback' ? 'Rolling back...' : 'Roll back'}</button></div>`);
    } else if (f.status === 'rolled-back') {
      parts.push(`<div class="actions"><span class="hint">Rolled back by @Executor. The resource is exactly as it was.</span></div>`);
    } else if (f.status === 'executing' || S.busy[f.id] === 'approve') {
      parts.push(`<div class="actions"><button class="btn primary big" disabled><span class="dot"></span>Executing via DuploCloud...</button><span class="hint">@Executor is being recruited into the Band room.</span></div>`);
    } else if (f.status === 'dry-run-passed') {
      const viaBand = S.config && S.config.band.mode === 'band'
        ? `<span class="hint">Or type <code>@Scout approve ${f.id}</code> in the Band room.</span>`
        : `<button class="btn" data-act="band-approve" title="Posts '@Scout approve ${f.id}' as a human participant in the Band room">Judge approves via Band</button>`;
      parts.push(`<div class="actions"><button class="btn primary big" data-act="approve">Approve and execute via DuploCloud</button>${viaBand}<span class="hint">Nothing runs until a human approves. Rollback stays one click away.</span></div>`);
    } else {
      parts.push(`<div class="actions"><button class="btn big" data-act="dryrun" ${S.busy[f.id] ? 'disabled' : ''}>${S.busy[f.id] === 'dryrun' ? 'Running dry run...' : 'Run dry run'}</button><span class="hint">Snapshot, DuploCloud lookup and rollback plan, without changing anything.</span></div>`);
    }
    return parts.join('');
  }

  function renderDetail(full) {
    const f = S.findings.get(S.selected);
    const box = $('#detail');
    if (!f) return;
    const isRefuse = f.verdict === 'refuse';
    if (full || !box.querySelector('.d-wrap') || box.dataset.id !== f.id) {
      box.dataset.id = f.id;
      box.innerHTML = `<div class="d-wrap">
        <div class="d-head"><div class="cat">${esc(f.category)} · ${esc(f.resources[0].provider)} · ${esc(f.resources[0].region)}</div>
          <h3>${esc(f.title)} <span id="dBadge">${badgeFor(f)}</span></h3>
          <div class="res">${esc(f.resources.map((r) => `${r.name} · ${r.spec}`).join('  |  '))}</div></div>
        <div class="stats">
          <div class="stat"><div class="k">${isRefuse ? 'Blocked / month' : 'Saves / month'}</div><div class="v ${isRefuse ? 'blocked' : 'g'}">${money(f.monthlySavings)}</div></div>
          <div class="stat"><div class="k">CO2 / month <span class="info" tabindex="0">i<span class="tip"><b>${kg(f.co2.kgSaved)} kg CO2e, ${f.co2.kwhSaved} kWh/mo</b><ul>${f.co2.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></span></span></div><div class="v ${isRefuse ? 'blocked' : 't'}">${kg(f.co2.kgSaved)} kg</div></div>
          <div class="stat"><div class="k">Confidence</div><div class="v">${Math.round((f.plan.confidence || 0) * 100)}%</div></div>
          <div class="stat"><div class="k">Risk</div><div class="v" style="color:${f.plan.risk === 'high' ? 'var(--red)' : f.plan.risk === 'medium' ? 'var(--amber)' : 'var(--green)'}">${esc(f.plan.risk || '-')}</div></div>
        </div>
        <div id="dGates">${gates(f)}</div>
        ${f.discovery ? `<div class="card"><div class="card-h">How the graph found it<span class="src">${f.discovery.engine === 'neo4j' ? 'Neo4j Cypher · live' : 'in-memory graph (same Cypher semantics)'}</span></div><div class="card-b"><p class="rationale" style="margin:0 0 8px">No <code>DEPENDS_ON</code> path reaches these resources from any live entrypoint (${esc(f.discovery.entrypoints.join(', '))}). Utilization metrics alone would not flag them.</p><pre class="qpre">${esc(f.discovery.cypher)}</pre></div></div>` : ''}
        <div class="card" id="blastCard"><div class="card-h">Blast radius<span class="src">${f.blast ? (f.blast.engine === 'neo4j' ? 'Neo4j Cypher · live' : 'in-memory graph (same Cypher semantics)') + ` · ${f.blast.ms} ms` : 'pending'}</span></div>
          <div class="blast"><div id="cy"></div><div class="blast-side" id="blastSide">${blastSide(f)}</div></div>
          ${f.blast ? `<details class="cypher"><summary>Show Cypher run by @SafetyCritic</summary><pre>${esc(f.blast.cypher)}\n// params: ${esc(JSON.stringify(f.blast.params))}</pre></details>` : ''}
        </div>
        <div id="dActions">${actionsHTML(f)}</div>
        <div id="dReceipt"></div>
        ${planCard(f)}
      </div>`;
      box.scrollTop = 0;
      drawGraph(f);
    } else {
      $('#dBadge').innerHTML = badgeFor(f);
      $('#dGates').innerHTML = gates(f);
      $('#dActions').innerHTML = actionsHTML(f);
      if (f.blast && cyFor !== f.id + ':' + (f.blast ? 1 : 0)) {
        $('#blastSide').innerHTML = blastSide(f);
        drawGraph(f);
      }
    }
    loadReceipt(f);
    const term = $('#term');
    if (term) term.scrollTop = term.scrollHeight;
    box.classList.toggle('refused', isRefuse);
  }

  $('#detail').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = S.selected;
    const act = btn.dataset.act;
    if (act === 'band-approve') {
      btn.disabled = true;
      api('/api/band/human-approve', 'POST', { id, user: 'judge@hackersquad' }).catch((err) => alert(err.message));
      return;
    }
    S.busy[id] = act;
    renderDetail(false);
    try {
      const r = await api(`/api/findings/${id}/${act}`, 'POST', { user: 'cto@acme.ai' });
      upsert(r.finding);
      if (r.totals) renderTotals(r.totals);
    } catch (err) {
      if (err.data && err.data.finding) upsert(err.data.finding);
      alert(err.message);
    } finally {
      delete S.busy[id];
      renderDetail(false);
    }
  });

  // ---------- proof receipt ----------
  const receiptKey = (f) => `${f.id}:${f.status}:${f.verdict}`;
  async function loadReceipt(f) {
    const box = $('#dReceipt');
    if (!box) return;
    const eligible = f.verdict === 'refuse' || f.status === 'executed' || f.status === 'rolled-back';
    if (!eligible || !f.criticSaid) {
      box.innerHTML = '';
      box.dataset.key = '';
      return;
    }
    if (box.dataset.key === receiptKey(f)) return;
    box.dataset.key = receiptKey(f);
    try {
      const r = await api(`/api/findings/${f.id}/receipt`);
      if (S.selected !== f.id) return;
      box.innerHTML = receiptHTML(r);
    } catch (err) {
      box.innerHTML = '';
    }
  }

  function receiptHTML(r) {
    const b = r.blastRadius;
    const deps = b.dependents.filter((d) => d.hops === 1).map((d) => d.name);
    const outcome = { executed: 'Executed', vetoed: 'Vetoed', 'rolled-back': 'Rolled back' }[r.outcome];
    const row = (k, v) => `<div class="rc-row"><span class="rc-k">${k}</span><span class="rc-v">${v}</span></div>`;
    return `<div class="card receipt ${r.outcome}">
      <div class="card-h">Proof receipt <span class="rc-id">${esc(r.receiptId)}</span>
        <a class="btn small" href="/api/findings/${encodeURIComponent(r.finding.ref)}/receipt?download=1" download="certain-receipt-${esc(r.receiptId)}.json">Download receipt</a></div>
      <div class="card-b">
        ${row('Outcome', `<b class="rc-out">${outcome}</b> · ${esc(r.finding.actionLabel)} on ${esc(r.finding.resources.map((x) => x.name).join(', '))}`)}
        ${row('Blast radius', `${b.directDependents} direct / ${b.totalDependents} total dependents${deps.length ? ` (${esc(deps.join(', '))})` : ''} · ${b.engine === 'neo4j' ? 'Neo4j' : 'in-memory graph'}`)}
        ${row('Critic verdict', `<b class="${r.criticVerdict.verdict === 'VETO' ? 'neg' : 'pos'}">${esc(r.criticVerdict.verdict)}</b> · ${esc(r.criticVerdict.reason)}`)}
        ${row('Dry run', r.dryRun ? `${r.dryRun.passed ? 'Passed' : 'Failed'} · ${r.dryRun.checks.filter((c) => c.ok).length}/${r.dryRun.checks.length} checks · ${esc(r.dryRun.mode)}` : 'Not run')}
        ${row('Approved', r.approval ? `${esc(r.approval.by)} · ${new Date(r.approval.at).toLocaleString()}` : 'No approval: nothing ran')}
        ${row('DuploCloud', r.duplocloud.command ? `<code>${esc(r.duplocloud.command)}</code> (${esc(r.duplocloud.mode || '')})` : esc(r.duplocloud.note))}
        ${row('Rollback', r.rollback ? `<code>${esc(r.rollback.handle)}</code>${r.rollback.performed ? ' · performed' : ''}` : 'n/a')}
        ${row('Impact', `<b class="pos">${money(r.impact.usdPerMonth)}/mo</b> · <b style="color:var(--teal)">${kg(r.impact.kgCo2PerMonth)} kg CO2/mo</b>${r.impact.realized ? '' : ' <span class="muted">(not realized)</span>'}`)}
        <details class="cypher"><summary>Cypher used</summary><pre>${esc(b.cypher)}\n// params: ${esc(JSON.stringify(b.params))}</pre></details>
        <div class="rc-hash">sha256 ${esc(r.sha256)}</div>
      </div></div>`;
  }

  function drawGraph(f) {
    const el = $('#cy');
    if (!el || !window.cytoscape) return;
    if (cy) cy.destroy();
    cyFor = f.id + ':' + (f.blast ? 1 : 0);
    const b = f.blast || { nodes: f.resources.map((r) => ({ id: r.id, name: r.name, role: 'target' })), edges: [] };
    const refuse = f.verdict === 'refuse';
    const color = { target: refuse ? '#ff5f6d' : f.blast ? '#3ddc97' : '#a78bfa', direct: refuse ? '#ff5f6d' : '#f5b84b', indirect: '#f5b84b', dependency: '#5d6b7c' };
    cy = window.cytoscape({
      container: el,
      elements: [
        ...b.nodes.map((n) => ({ data: { id: n.id, label: n.name, role: n.role, color: color[n.role] } })),
        ...b.edges.map((e, i) => ({ data: { id: 'e' + i, source: e.from, target: e.to, kind: e.kind } })),
      ],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', color: '#d7dee7', 'font-size': 10, 'font-family': 'JetBrains Mono, monospace', 'text-valign': 'bottom', 'text-margin-y': 6, width: 18, height: 18, 'border-width': 2, 'border-color': '#0b1118', 'text-outline-color': '#0d141c', 'text-outline-width': 2 } },
        { selector: 'node[role = "target"]', style: { width: 34, height: 34, 'font-size': 11, 'font-weight': 700, 'border-width': 4, 'border-color': refuse ? 'rgba(255,95,109,0.35)' : 'rgba(61,220,151,0.35)' } },
        { selector: 'node[role = "indirect"]', style: { opacity: 0.75 } },
        { selector: 'node[role = "dependency"]', style: { opacity: 0.6, shape: 'round-rectangle' } },
        { selector: 'edge', style: { width: 1.5, 'line-color': '#2f4054', 'target-arrow-color': '#2f4054', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.8, label: b.edges.length <= 4 ? 'data(kind)' : '', 'font-size': 7, color: '#5d6b7c', 'text-rotation': 'autorotate', 'text-background-color': '#0d141c', 'text-background-opacity': 1 } },
        { selector: `edge[target = "${f.resources[0].id}"]`, style: { 'line-color': refuse ? '#ff5f6d' : '#f5b84b', 'target-arrow-color': refuse ? '#ff5f6d' : '#f5b84b', width: 2.2 } },
      ],
      layout: b.nodes.length > 1 ? { name: 'breadthfirst', directed: true, spacingFactor: 1.05, padding: 24, animate: true, animationDuration: 400 } : { name: 'grid', padding: 90 },
      userZoomingEnabled: false,
      boxSelectionEnabled: false,
    });
    if (b.nodes.length === 1) cy.zoom({ level: 1.3, position: cy.nodes()[0].position() });
    cy.center();
  }

  // ---------- state sync ----------
  const FOCUS_VETO = new URLSearchParams(location.search).get('focus') === 'veto';
  function showVeto() {
    const v = S.order.map((id) => S.findings.get(id)).find((f) => f.verdict === 'refuse');
    if (v) select(v.id);
    return Boolean(v);
  }
  $('#vetoBtn').addEventListener('click', showVeto);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'v' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) showVeto();
  });

  function upsert(f) {
    if (!S.findings.has(f.id)) S.order.push(f.id);
    S.findings.set(f.id, f);
    renderList();
    renderFoundCounter();
    $('#vetoBtn').hidden = ![...S.findings.values()].some((x) => x.verdict === 'refuse');
    if (S.focusResource && f.resources.some((r) => r.id === S.focusResource) && f.criticSaid) {
      S.focusResource = null;
      select(f.id);
    } else if (FOCUS_VETO && f.verdict === 'refuse' && S.selected !== f.id && !S.vetoFocused) {
      S.vetoFocused = true;
      select(f.id);
    } else if (!S.selected) select(f.id);
    else if (S.selected === f.id) renderDetail(false);
  }

  function resetUI() {
    S.findings.clear();
    S.order = [];
    S.selected = null;
    S.summary = null;
    S.vetoFocused = false;
    $('#vetoBtn').hidden = true;
    $('#room').innerHTML = '';
    $('#detail').innerHTML = `<div class="empty-state big"><p>Proof before action</p><p class="muted">Every fix passes four gates: blast radius, dry run, human approval, DuploCloud execution with rollback.</p></div>`;
    delete $('#detail').dataset.id;
    renderList();
    renderFoundCounter();
    renderTotals({ savedMonthly: 0, savedKg: 0, executed: 0 });
    renderMeter({ spent: 0, budget: S.config ? S.config.llm.budget : 0.5, tokens: 0, calls: 0, liveCalls: 0, tokensPerSec: 0 });
  }

  function setRunning(on) {
    const b = $('#auditBtn');
    b.classList.toggle('running', on);
    b.disabled = on;
    b.innerHTML = `<span class="dot"></span>${on ? 'Auditing...' : 'Run audit'}`;
    $('#resetBtn').disabled = on;
  }

  $('#auditBtn').addEventListener('click', async () => {
    resetUI();
    await api('/api/reset', 'POST').catch(() => {});
    $('#room').innerHTML = '';
    setRunning(true);
    try {
      await api('/api/audit', 'POST', { user: 'cto@acme.ai' });
    } catch (err) {
      alert(err.message);
      setRunning(false);
    }
  });
  $('#resetBtn').addEventListener('click', async () => {
    await api('/api/reset', 'POST').catch((e) => alert(e.message));
    resetUI();
  });

  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      S.participants = new Set(d.participants);
      renderMembers();
    });
    es.addEventListener('room', (e) => addRoom(JSON.parse(e.data)));
    es.addEventListener('finding', (e) => upsert(JSON.parse(e.data)));
    es.addEventListener('meter', (e) => renderMeter(JSON.parse(e.data)));
    es.addEventListener('totals', (e) => renderTotals(JSON.parse(e.data)));
    es.addEventListener('graph', () => {
      graphDirty = true;
      if (!$('#graphView').hidden) loadGraph();
    });
    es.addEventListener('integrations', (e) => renderIntegrations(JSON.parse(e.data)));
    es.addEventListener('summary', (e) => {
      const d = JSON.parse(e.data);
      S.summary = d.summary;
      renderMeter(d.summary.meter);
      renderFoundCounter();
      setRunning(false);
    });
    es.addEventListener('reset', () => {
      S.participants.delete('Executor');
      renderMembers();
    });
    es.addEventListener('error', (e) => {
      if (e.data) {
        alert(JSON.parse(e.data).message);
        setRunning(false);
      }
    });
  }

  // ---------- Graph tab ----------
  let gcy = null;
  let graphDirty = true;
  function setTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    $('#graphView').hidden = name !== 'graph';
    $('#auditView').hidden = name !== 'audit';
    if (name === 'graph') loadGraph();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

  async function loadGraph() {
    const g = await api('/api/graph');
    graphDirty = false;
    const orphanIds = new Set(g.orphans.orphans.map((o) => o.id));
    const flagged = new Set(g.flagged);
    const vetoed = new Set(g.vetoed);
    $('#gvMeta').textContent = `${g.nodes.length} resources · ${g.edges.length} DEPENDS_ON · ${g.nodes.filter((n) => n.entrypoint).length} entrypoints · ${g.engine === 'neo4j' ? 'Neo4j' : 'in-memory'}`;
    const color = (n) => (vetoed.has(n.id) ? '#ff5f6d' : n.entrypoint ? '#5cc8ff' : flagged.has(n.id) || n.waste ? '#f5b84b' : orphanIds.has(n.id) ? '#a78bfa' : '#3a4a5c');
    if (gcy) gcy.destroy();
    gcy = window.cytoscape({
      container: $('#gcy'),
      elements: [
        ...g.nodes.map((n) => ({ data: { id: n.id, label: n.name.replace(/ \(.*\)$/, ''), color: color(n), orphan: orphanIds.has(n.id) ? 1 : 0, ep: n.entrypoint ? 1 : 0, size: 16 + Math.min(26, Math.sqrt(n.monthlyCost || 0) / 2.2) } })),
        ...g.edges.map((e, i) => ({ data: { id: 'g' + i, source: e.from, target: e.to } })),
      ],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', width: 'data(size)', height: 'data(size)', label: 'data(label)', color: '#c9d3de', 'font-size': 9, 'font-family': 'JetBrains Mono, monospace', 'text-valign': 'bottom', 'text-margin-y': 4, 'text-outline-color': '#0c131b', 'text-outline-width': 2 } },
        { selector: 'node[ep = 1]', style: { shape: 'diamond' } },
        { selector: 'node[orphan = 1]', style: { 'border-width': 3, 'border-style': 'dashed', 'border-color': '#a78bfa' } },
        { selector: 'edge', style: { width: 1.3, 'line-color': '#2a3a4c', 'target-arrow-color': '#2a3a4c', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7 } },
      ],
      layout: { name: 'breadthfirst', directed: true, roots: g.nodes.filter((n) => n.entrypoint || !g.edges.some((e) => e.to === n.id)).map((n) => '#' + n.id).join(','), spacingFactor: 0.95, padding: 20 },
      boxSelectionEnabled: false,
    });
    const max = Math.max(1, ...g.teams.rows.map((r) => r.waste));
    $('#teams').innerHTML = g.teams.rows
      .map((r) => `<div class="team-row"><span>${esc(r.team)}</span><span class="bar"><i style="width:${(r.waste / max) * 100}%"></i></span><span class="v"><b>${money(r.waste)}</b> / ${money(r.spend)}</span></div>`)
      .join('') + `<div class="muted" style="font-size:11.5px">Waste = actionable findings from the last audit, written back to the graph. ${g.teams.engine === 'neo4j' ? 'Neo4j' : 'In-memory'} rollup.</div>`;
    $('#queries').innerHTML = g.queries
      .map((q) => `<div class="q"><h4>${esc(q.name)}<span class="eng">${q.engine === 'neo4j' ? 'NEO4J' : 'IN-MEMORY'}</span></h4><pre>${esc(q.cypher)}</pre><div class="res">${esc(q.result)}</div></div>`)
      .join('');
  }

  // ---------- Try it on your bill ----------
  const modal = $('#billModal');
  const openBill = () => {
    modal.hidden = false;
    $('#billOut').innerHTML = '';
  };
  $('#billBtn').addEventListener('click', openBill);
  $('#billClose').addEventListener('click', () => (modal.hidden = true));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal.hidden = true;
  });

  async function analyze(csv, name) {
    $('#billOut').innerHTML = `<div class="actions" style="margin-top:14px"><span class="hint">@Scout is reading ${esc(name)} on this machine...</span></div>`;
    try {
      const r = await api('/api/bill/analyze', 'POST', { csv, name });
      S.bill = r;
      renderBill(r);
    } catch (err) {
      $('#billOut').innerHTML = `<div class="refusal" style="margin-top:14px"><h4>Could not read that CSV</h4><p>${esc(err.message)}</p></div>`;
    }
  }
  $('#sampleBtn').addEventListener('click', async () => {
    const csv = await fetch('/api/bill/sample').then((r) => r.text());
    analyze(csv, 'sample-bill.csv');
  });
  const readFile = (file) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return alert('That file is over 8 MB; export a monthly summary (group by resource) instead.');
    file.text().then((t) => analyze(t, file.name));
  };
  $('#billFile').addEventListener('change', (e) => readFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over'))));
  drop.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));

  function renderBill(r) {
    const cols = Object.entries(r.detected).map(([k, v]) => `<code>${esc(k)} = ${esc(v)}</code>`).join('');
    $('#billOut').innerHTML = `
      <div class="bill-sum">
        <div class="stat"><div class="k">Monthly bill</div><div class="v">${money(r.totalMonthly)}</div></div>
        <div class="stat"><div class="k">Waste found</div><div class="v a">${money(r.wasteMonthly)}<small style="font-size:13px;color:var(--muted)">/mo</small></div></div>
        <div class="stat"><div class="k">Share of bill</div><div class="v a">${r.wastePct}%</div></div>
        <div class="stat"><div class="k">CO2 avoidable</div><div class="v t">${r.kgCo2Monthly.toLocaleString()} kg<small style="font-size:13px;color:var(--muted)">/mo</small></div></div>
      </div>
      <div class="scout-note"><span class="av Scout" style="width:26px;height:26px">S</span><div>${esc(r.scout.text)}<div class="src">@Scout · ${r.scout.source === 'crusoe' ? 'Kimi K2.6 on Crusoe (summary only)' : 'canned (demo mode)'} · ${r.findingsCount} findings from ${r.lineItems} line items in ${r.ms} ms · parsed locally</div></div></div>
      <div class="cols">Detected ${esc(r.format)} columns: ${cols}</div>
      <div class="bcards">${r.top
        .map(
          (f) => `<div class="bcard" data-bid="${f.id}">
          <div class="t">${esc(f.title)}</div>
          <div class="r">${esc(f.resource)} · ${esc(f.service)}</div>
          <div class="d">${esc(f.detail)}</div>
          <div class="n"><span class="m">${money(f.savings)}/mo</span><span class="c">${kg(f.kgCo2)} kg CO2/mo</span></div>
          <div class="foot2"><span class="conf">${esc(f.confidence)} confidence</span><span class="note" id="note-${f.id}"></span>
            <button class="btn small ${f.envResourceId ? 'primary' : ''}" data-prove="${f.id}">Prove &amp; fix</button></div>
        </div>`
        )
        .join('')}</div>
      ${r.others.length ? `<div class="cols" style="margin-top:12px">Also found: ${r.others.map((o) => `${esc(o.title)} (${esc(o.resource)}, ${money(o.savings)})`).join(' · ')}</div>` : ''}`;
  }

  $('#billOut').addEventListener('click', (e) => {
    const b = e.target.closest('[data-prove]');
    if (!b) return;
    const f = S.bill.top.find((x) => x.id === b.dataset.prove);
    if (!f.envResourceId) {
      $(`#note-${f.id}`).textContent = 'Connect DuploCloud to act: this resource is not in a connected tenant.';
      b.disabled = true;
      return;
    }
    proveResource(f.envResourceId);
  });

  function findingFor(resourceId) {
    return [...S.findings.values()].find((x) => x.resources.some((r) => r.id === resourceId));
  }
  async function proveResource(resourceId) {
    modal.hidden = true;
    const existing = findingFor(resourceId);
    if (existing) return select(existing.id);
    S.focusResource = resourceId;
    if (!$('#auditBtn').disabled) $('#auditBtn').click();
  }

  async function boot() {
    renderConfig(await api('/api/config'));
    const st = await api('/api/state');
    S.participants = new Set(st.participants);
    renderMembers();
    st.room.forEach(addRoom);
    st.findings.forEach(upsert);
    renderMeter(st.meter);
    S.summary = st.summary;
    renderTotals(st.totals);
    renderFoundCounter();
    setRunning(st.running);
    connect();
  }
  boot();
})();
