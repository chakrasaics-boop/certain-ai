// "Try it on your bill": analyze an AWS CUR / Cost Explorer / generic cost CSV locally.
// Deterministic detectors find the waste; the Scout (Crusoe, or canned) writes the summary.
// Raw rows never leave this process. In live mode only aggregated finding summaries
// (titles and dollar amounts, no account or resource IDs) are sent to Crusoe.

const llm = require('./llm');
const openrouter = require('./openrouter');
const { ASSUMPTIONS } = require('./co2');

// ---------- CSV ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  const headers = (rows.shift() || []).map((h) => h.trim());
  return { headers, rows };
}

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const COLS = {
  service: ['lineitemproductcode', 'productproductname', 'productname', 'productcode', 'service', 'servicename', 'awsservice', 'product'],
  resource: ['lineitemresourceid', 'resourceid', 'resource', 'resourcename', 'instanceid', 'arn'],
  usageType: ['lineitemusagetype', 'usagetype', 'sku', 'lineitemoperation', 'operation', 'instancetype'],
  usage: ['lineitemusageamount', 'usageamount', 'usagequantity', 'quantity', 'usagehours', 'hours', 'units', 'usage'],
  cost: ['lineitemunblendedcost', 'unblendedcost', 'lineitemnetunblendedcost', 'netunblendedcost', 'blendedcost', 'lineitemblendedcost', 'cost', 'costusd', 'amount', 'amountusd', 'totalcost', 'monthlycost', 'spend', 'charges'],
  desc: ['lineitemlineitemdescription', 'lineitemdescription', 'description', 'itemdescription'],
  name: ['resourcetagsusername', 'resourcetagsname', 'name', 'tagname', 'resourcename'],
  util: ['avgutilizationpct', 'utilization', 'utilizationpct', 'avgcpu', 'cpuutilization', 'avgcpuutilization', 'cpu', 'gpuutil', 'gpuutilization', 'avgutilization'],
  status: ['status', 'state', 'attachmentstate', 'attachment', 'resourcestatus'],
};

function detectColumns(headers) {
  const n = headers.map(norm);
  const map = {};
  for (const [key, cands] of Object.entries(COLS)) {
    let idx = -1;
    for (const c of cands) {
      idx = n.indexOf(c);
      if (idx >= 0) break;
    }
    if (idx < 0) idx = n.findIndex((h) => cands.some((c) => c.length > 4 && h.includes(c)));
    if (idx >= 0 && !Object.values(map).includes(idx)) map[key] = idx;
  }
  return map;
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};

// Cost Explorer "wide" export: one column per service ("EC2-Instances($)"), one row per period.
function fromWide(headers, rows) {
  const cols = headers.map((h, i) => ({ h, i })).filter((c) => /\(\$\)|usd/i.test(c.h) && !/^total/i.test(c.h));
  if (cols.length < 2) return null;
  const totalRow = rows.find((r) => /total/i.test(r[0] || ''));
  const use = totalRow ? [totalRow] : rows;
  return cols.map((c) => ({
    service: c.h.replace(/\s*\(\$\)\s*/, '').trim(),
    resource: '',
    usageType: '',
    usage: null,
    cost: use.reduce((a, r) => a + (num(r[c.i]) || 0), 0),
    desc: '',
    name: '',
    util: null,
    status: '',
  }));
}

function lineItems(text) {
  const { headers, rows } = parseCSV(text);
  if (!headers.length) throw new Error('Empty CSV');
  const map = detectColumns(headers);
  let items;
  let format;
  const wide = headers.filter((h) => /\(\$\)/.test(h)).length >= 2 ? fromWide(headers, rows) : null;
  if (wide) {
    items = wide;
    format = 'cost-explorer-wide';
  } else if (map.cost === undefined) {
    items = fromWide(headers, rows);
    format = 'cost-explorer-wide';
    if (!items) throw new Error(`Could not find a cost column. Headers: ${headers.slice(0, 12).join(', ')}`);
  } else {
    format = headers.some((h) => /^lineItem\//i.test(h)) ? 'aws-cur' : 'generic';
    const g = (r, k) => (map[k] === undefined ? '' : (r[map[k]] || '').trim());
    items = rows.map((r) => ({
      service: g(r, 'service'),
      resource: g(r, 'resource'),
      usageType: g(r, 'usageType'),
      usage: num(g(r, 'usage')),
      cost: num(g(r, 'cost')) || 0,
      desc: g(r, 'desc'),
      name: g(r, 'name'),
      util: num(g(r, 'util')),
      status: g(r, 'status').toLowerCase(),
    }));
  }
  const detected = Object.fromEntries(Object.entries(map).map(([k, i]) => [k, headers[i]]));
  return { items: items.filter((x) => x.cost > 0), detected, format, rowCount: rows.length };
}

// ---------- grouping + detectors ----------
const GPU_RE = /\b(p3|p3dn|p4d|p4de|p5|p5e|p5en|g4dn|g4ad|g5|g5g|g6|g6e|gr6|trn1|trn2|inf1|inf2|dl1)\.\w+/i;
const LLM_RE = /(token|bedrock|openai|anthropic|claude|gpt-|gemini|vertex ai|azure openai|mistral|cohere)/i;
const SIZE_VCPU = { nano: 0.5, micro: 1, small: 1, medium: 2, large: 2, xlarge: 4, '2xlarge': 8, '2xl': 8, '4xlarge': 16, '4xl': 16, '8xlarge': 32, '8xl': 32, '12xlarge': 48, '16xlarge': 64, '24xlarge': 96, '48xlarge': 192, xl: 4 };
const PUE = ASSUMPTIONS.pue.value;
const GRID = ASSUMPTIONS.grid['us-east-1'].value;
const kgFromKwh = (kwh) => kwh * PUE * GRID;

function instanceType(text) {
  const m = text.match(/(?:db\.|cache\.)?([a-z][a-z0-9-]*\d[a-z0-9-]*)\.(\d*x?l(?:arge)?|nano|micro|small|medium|large|xlarge)/i);
  return m ? { family: m[1].toLowerCase(), size: m[2].toLowerCase() } : null;
}
function computeWatts(text, gpu) {
  const it = instanceType(text);
  const vcpu = it ? SIZE_VCPU[it.size] || 4 : 4;
  const base = vcpu * 4.5; // ~CPU + memory draw per vCPU at low load (CCF-style average)
  if (!gpu) return base;
  const perGpu = /p4d|p4de|p5/.test(text) ? 250 : 70; // idle-ish draw per accelerator
  const gpus = /p4d|p4de|p5/.test(text) ? 8 : /12xlarge|24xlarge|48xlarge/.test(text) ? 4 : 1;
  return base + perGpu * gpus;
}

function groupItems(items) {
  const groups = new Map();
  // Instances named web-1, web-2, ... are one fleet; a lone "gpu-finetune-01" keeps its name.
  const prefixCount = new Map();
  for (const it of items) if (it.name) prefixCount.set(it.name.replace(/-\d+$/, ''), (prefixCount.get(it.name.replace(/-\d+$/, '')) || new Set()).add(it.name));
  const fleet = (n) => (n && prefixCount.get(n.replace(/-\d+$/, ''))?.size > 1 ? n.replace(/-\d+$/, '') : n);
  for (const it of items) {
    const isInstance = /^i-/.test(it.resource) || /BoxUsage/i.test(it.usageType);
    const key = (it.name && isInstance ? fleet(it.name) : '') || it.resource || it.name || `${it.service}|${it.usageType}`;
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()].map((g) => {
    const f = g.items[0];
    const utils = g.items.map((x) => x.util).filter((x) => x != null);
    return {
      key: g.key,
      items: g.items,
      service: f.service,
      name: f.name ? fleet(f.name) : '',
      resources: [...new Set(g.items.map((x) => x.resource).filter(Boolean))],
      usageTypes: [...new Set(g.items.map((x) => x.usageType).filter(Boolean))],
      text: g.items.map((x) => `${x.service} ${x.usageType} ${x.desc} ${x.name}`).join(' '),
      cost: g.items.reduce((a, x) => a + x.cost, 0),
      hours: g.items.filter((x) => /BoxUsage|InstanceUsage|Multi-AZUsage|NodeUsage|ESInstance|Kafka/i.test(x.usageType)).reduce((a, x) => a + (x.usage || 0), 0),
      util: utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null,
      status: g.items.map((x) => x.status).find(Boolean) || '',
      count: g.items.length,
    };
  });
}

const label = (g) => g.name || g.resources[0] || g.usageTypes[0] || g.service;

function detect(g) {
  const out = [];
  const t = g.text;
  const push = (o) => out.push({ group: g, ...o, savings: Math.round(o.savings * 100) / 100 });
  const gpu = GPU_RE.test(t);

  if (LLM_RE.test(t) && !/BoxUsage|EBS|NatGateway/i.test(t)) {
    let tin = 0;
    let tout = 0;
    for (const it of g.items) {
      if (!/token/i.test(it.usageType + it.desc) || it.usage == null) continue;
      if (/output|completion/i.test(it.usageType + it.desc)) tout += it.usage;
      else tin += it.usage;
    }
    const estimated = !(tin + tout);
    if (estimated) {
      tin = (g.cost / 7.5) * 1e6 * 0.82; // assume ~$7.5 per 1M blended tokens for a frontier model
      tout = (g.cost / 7.5) * 1e6 * 0.18;
    }
    const P = llm.MODELS.planner;
    const crusoe = (tin * P.priceIn + tout * P.priceOut) / 1e6;
    const savings = g.cost - crusoe;
    if (savings > 25) {
      const kwhBefore = ((tin + tout) / 1000) * ASSUMPTIONS.closedModelWhPer1kTok.value / 1000;
      const kwhAfter = ((tin + tout) / 1000) * ASSUMPTIONS.openModelWhPer1kTok.value / 1000;
      push({
        kind: 'llm',
        title: 'Closed-model LLM spend',
        detail: `${Math.round((tin + tout) / 1e6)}M tokens/mo${estimated ? ' (estimated from $)' : ''} on ${g.service || 'a closed model API'}. Same tokens on ${P.id} at Crusoe rates: $${Math.round(crusoe).toLocaleString()}/mo.`,
        action: 'Re-route to an open model on Crusoe (canary)',
        savings,
        kg: kwhBefore * GRID - kwhAfter * ASSUMPTIONS.grid.crusoe.value,
        confidence: estimated ? 'medium' : 'high',
        tokens: { in: Math.round(tin), out: Math.round(tout), estimated, crusoe: Math.round(crusoe) },
      });
    }
    return out;
  }

  if (/SnapshotUsage/i.test(t) && g.cost > 50) {
    const gb = g.items.reduce((a, x) => a + (x.usage || 0), 0);
    push({ kind: 'snapshots', title: 'Old EBS snapshots', detail: `${Math.round(gb).toLocaleString()} GB-month of snapshots (${label(g)}). A 90-day retention policy removes about half.`, action: 'Apply snapshot lifecycle policy', savings: g.cost * 0.5, kg: kgFromKwh((gb / 1024) * 1.2 * 730 / 1000) * 0.5, confidence: 'medium' });
    return out;
  }

  const unattached = /unattached|available|detached|idle/.test(g.status) || /IdleAddress/i.test(t);
  if (unattached && /EBS:Volume|ElasticIP|IdleAddress/i.test(t)) {
    const gb = g.items.filter((x) => /VolumeUsage/i.test(x.usageType)).reduce((a, x) => a + (x.usage || 0), 0);
    const eip = /ElasticIP|IdleAddress/i.test(t);
    push({
      kind: eip ? 'eip' : 'volume',
      title: eip ? 'Idle Elastic IP' : 'Unattached EBS volume',
      detail: eip ? 'Elastic IP not attached to a running instance.' : `${label(g)}: ${gb.toLocaleString()} GB${/piops|io1|io2/i.test(t) ? ' with provisioned IOPS' : ''}, unattached.`,
      action: eip ? 'Release address' : 'Snapshot to archive tier + delete',
      savings: eip ? g.cost : g.cost * 0.97,
      kg: kgFromKwh((gb / 1024) * ASSUMPTIONS.ssdWhPerTBh.value * ASSUMPTIONS.ebsReplication.value * 730 / 1000),
      confidence: 'high',
    });
    return out;
  }

  if (/NatGateway-Bytes/i.test(t) && g.cost > 100) {
    const gb = g.items.filter((x) => /NatGateway-Bytes/i.test(x.usageType)).reduce((a, x) => a + (x.usage || 0), 0);
    push({ kind: 'nat', title: 'NAT Gateway data processing', detail: `${gb.toLocaleString()} GB/mo through ${label(g)}. S3/ECR/DynamoDB traffic can use free gateway endpoints.`, action: 'Add VPC gateway endpoints', savings: g.cost * 0.55, kg: kgFromKwh(gb * 0.001) * 0.55, confidence: 'medium' });
    return out;
  }
  if (/DataTransfer-Out/i.test(t) && !/CloudFront/i.test(t) && g.cost > 300) {
    const gb = g.items.reduce((a, x) => a + (x.usage || 0), 0);
    push({ kind: 'transfer', title: 'Data transfer out spike', detail: `${gb.toLocaleString()} GB/mo egress direct from EC2/S3. Serving through CloudFront plus compression typically cuts about 30%.`, action: 'Front with CloudFront + compression', savings: g.cost * 0.3, kg: kgFromKwh(gb * 0.001) * 0.3, confidence: 'low' });
    return out;
  }

  const isCompute = /BoxUsage|InstanceUsage|Multi-AZUsage|NodeUsage|ESInstance|Kafka/i.test(t) || /^(ec2|amazonec2|compute|vm|virtual machines?|rds|amazonrds|compute engine)$/i.test(g.service.trim()) || /\b(ec2|instance|vm)\b/i.test(g.service);
  if (isCompute) {
    const watts = computeWatts(t, gpu) * Math.max(1, g.count);
    const kwhMonth = (watts * 730) / 1000;
    const db = /RDS|db\./i.test(t);
    if (g.util != null && g.util < 5) {
      push({
        kind: gpu ? 'gpu-idle' : db ? 'db-idle' : 'idle',
        title: gpu ? 'Idle GPU instance' : db ? 'Low-traffic database' : 'Idle compute',
        detail: `${label(g)}: ${g.util}% average utilization${g.hours ? ` over ${Math.round(g.hours)} instance-hours` : ''}.${db ? ' Check dependents before stopping.' : ''}`,
        action: db ? 'Snapshot + stop (after blast-radius check)' : 'Snapshot + stop',
        savings: g.cost,
        kg: kgFromKwh(kwhMonth),
        confidence: 'high',
      });
    } else if (g.util != null && g.util < 25) {
      push({ kind: gpu ? 'gpu-rightsize' : 'rightsize', title: gpu ? 'Under-used GPU' : db ? 'Oversized database' : g.count > 1 ? 'Over-provisioned node group' : 'Oversized compute', detail: `${label(g)}${g.count > 1 ? ` (${g.count} instances)` : ''}: ${Math.round(g.util)}% average utilization. Half the capacity still leaves >2x headroom.`, action: g.count > 1 ? 'Scale down by half' : 'Rightsize one step down', savings: g.cost * 0.5, kg: kgFromKwh(kwhMonth) * 0.5, confidence: 'medium' });
    } else if (gpu && g.util == null) {
      push({ kind: 'gpu-unknown', title: 'GPU instance, utilization unknown', detail: `${label(g)} bills ${Math.round(g.hours || 730)} GPU-hours. Add a utilization column (or CloudWatch/DCGM) to confirm; off-hours scheduling alone saves ~30%.`, action: 'Schedule off-hours / verify utilization', savings: g.cost * 0.3, kg: kgFromKwh(kwhMonth) * 0.3, confidence: 'low' });
    }
  }
  return out;
}

// Map a bill line to a resource in the connected environment (by id, name or volume prefix).
function matchEnv(g, env) {
  const ids = [...g.resources, g.name, g.key].filter(Boolean).map((s) => s.toLowerCase());
  const tail = (s) => s.split(/[:/]/).pop();
  return (
    env.resources.find((r) => {
      const rn = r.name.toLowerCase();
      const short = rn.split(' ')[0];
      return ids.some((i) => i === r.id.toLowerCase() || i === rn || tail(i) === rn || (short.length > 6 && /^vol-/.test(short) && i.startsWith(short)));
    }) || null
  );
}

async function analyzeBill(text, { env, source = 'upload' } = {}) {
  const started = Date.now();
  const { items, detected, format, rowCount } = lineItems(text);
  const total = items.reduce((a, x) => a + x.cost, 0);
  const groups = groupItems(items);
  const findings = groups
    .flatMap(detect)
    .filter((f) => f.savings > 1)
    .sort((a, b) => b.savings - a.savings);

  const llmFinding = findings.find((f) => f.kind === 'llm');
  if (llmFinding) {
    const q = await openrouter.quoteWorkload((llmFinding.tokens.in + llmFinding.tokens.out) / 1e6, llmFinding.tokens.in / (llmFinding.tokens.in + llmFinding.tokens.out));
    llmFinding.quote = q;
    if (q.rows.length) llmFinding.detail += ` OpenRouter ${q.source} prices for the same tokens: ${q.rows.map((r) => `${r.model} $${r.monthly.toLocaleString()}`).join(', ')}.`;
  }

  const out = findings.map((f, i) => {
    const m = env ? matchEnv(f.group, env) : null;
    return {
      id: `b${i + 1}`,
      kind: f.kind,
      title: f.title,
      resource: label(f.group),
      service: f.group.service,
      detail: f.detail,
      action: f.action,
      monthlyCost: Math.round(f.group.cost * 100) / 100,
      savings: Math.round(f.savings),
      kgCo2: Math.round(f.kg * 10) / 10,
      confidence: f.confidence,
      lines: f.group.count,
      envResourceId: m ? m.id : null,
      envResourceName: m ? m.name : null,
      quote: f.quote || null,
      tokens: f.tokens || null,
    };
  });

  const waste = out.reduce((a, f) => a + f.savings, 0);
  const kg = out.reduce((a, f) => a + f.kgCo2, 0);
  const result = {
    source,
    format,
    detected,
    rowCount,
    lineItems: items.length,
    totalMonthly: Math.round(total * 100) / 100,
    wasteMonthly: Math.round(waste),
    wastePct: total ? Math.round((waste / total) * 1000) / 10 : 0,
    kgCo2Monthly: Math.round(kg),
    findingsCount: out.length,
    top: out.slice(0, 5),
    others: out.slice(5).map(({ title, resource, savings }) => ({ title, resource, savings })),
    privacy: 'Parsed on this machine. Raw rows are never uploaded.',
    ms: Date.now() - started,
  };
  result.scout = await scoutSummary(result);
  return result;
}

async function scoutSummary(r) {
  const canned = () =>
    `Your bill is $${Math.round(r.totalMonthly).toLocaleString()}/mo and about $${r.wasteMonthly.toLocaleString()}/mo (${r.wastePct}%) looks like waste. Biggest items: ${r.top
      .slice(0, 3)
      .map((f) => `${f.title.toLowerCase()} (${f.resource}, $${f.savings.toLocaleString()}/mo)`)
      .join('; ')}. Every fix still goes through the blast-radius check, dry run and your approval before anything changes.`;
  if (!llm.isLive()) return { text: canned(), source: 'canned' };
  try {
    const summary = r.top.map((f) => ({ title: f.title, service: f.service, savingsPerMonth: f.savings, confidence: f.confidence }));
    const res = await llm.chatJSON(
      'planner',
      'You are CertAIn\'s Scout, a FinOps engineer. Given aggregated bill findings (no raw data), write a 2-3 sentence plain-English summary for a CTO: total waste, the top items, and that each fix is proven safe before acting. Respond with ONLY JSON: {"summary": string}',
      JSON.stringify({ totalMonthly: Math.round(r.totalMonthly), wasteMonthly: r.wasteMonthly, wastePct: r.wastePct, findings: summary }),
      500
    );
    const m = new llm.Meter();
    m.record('planner', res.tokensIn, res.tokensOut, res.ms, true);
    return { text: res.json.summary || canned(), source: 'crusoe', cost: m.spent, tokens: res.tokensIn + res.tokensOut };
  } catch (err) {
    return { text: canned(), source: 'canned', error: err.message.slice(0, 120) };
  }
}

module.exports = { analyzeBill, parseCSV, detectColumns, lineItems };
