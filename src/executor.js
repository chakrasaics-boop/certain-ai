// DuploCloud executor. Two modes, one interface:
//  - live:      DUPLO_HOST + DUPLO_TOKEN + DUPLO_TENANT set -> shell out to `duploctl`
//  - simulated: realistic log lines, same rollback semantics
// Everything that touches real infrastructure lives in this file.

const { execFile } = require('child_process');

const isLive = () => Boolean(process.env.DUPLO_HOST && process.env.DUPLO_TOKEN && process.env.DUPLO_TENANT);

// Action -> duploctl commands. `null` = no duploctl equivalent; that step is simulated
// even in live mode and the log says so. Verify flags with `duploctl <resource> --help`.
function commandsFor(finding) {
  const r = finding.resources[0];
  switch (finding.action) {
    case 'stop':
      if (r.type === 'rds') {
        return { dryRun: ['rds', 'find', r.name], apply: ['rds', 'stop', r.name], rollback: ['rds', 'start', r.name] };
      }
      return { dryRun: ['hosts', 'find', r.name], apply: ['hosts', 'stop', r.name], rollback: ['hosts', 'start', r.name] };
    case 'rightsize':
      return {
        dryRun: ['rds', 'find', r.name],
        apply: ['rds', 'set_instance_size', r.name, 'db.r6g.xlarge'],
        rollback: ['rds', 'set_instance_size', r.name, 'db.r6g.4xlarge'],
      };
    case 'scale':
      return {
        dryRun: ['asg', 'find', r.name],
        apply: ['asg', 'scale', r.name, '--min', String(r.targetNodes), '--max', '8'],
        rollback: ['asg', 'scale', r.name, '--min', String(r.metrics.nodes), '--max', '8'],
      };
    case 'reroute-llm':
      return {
        dryRun: ['service', 'find', 'llm-gateway'],
        apply: ['service', 'update_env', 'llm-gateway', '--setvar', 'SUPPORT_COPILOT_ROUTE', 'crusoe/moonshotai/Kimi-K2.6'],
        rollback: ['service', 'update_env', 'llm-gateway', '--setvar', 'SUPPORT_COPILOT_ROUTE', 'closed/default'],
      };
    case 'decommission': {
      const svc = finding.resources.find((x) => /k8s/.test(x.type));
      if (!svc) return { dryRun: null, apply: null, rollback: null };
      return { dryRun: ['service', 'find', svc.name], apply: ['service', 'scale', svc.name, '0'], rollback: ['service', 'scale', svc.name, '2'] };
    }
    default:
      return { dryRun: null, apply: null, rollback: null }; // EBS delete / S3 BPA: simulated
  }
}

const printable = (args) => (args ? `duploctl ${args.join(' ')}` : null);

function runDuploctl(args) {
  return new Promise((resolve) => {
    execFile(
      process.env.DUPLOCTL_BIN || 'duploctl',
      args, // duploctl reads DUPLO_HOST / DUPLO_TOKEN / DUPLO_TENANT from the environment
      { timeout: 60000, env: process.env },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || stderr || (err && err.message) || '').trim().slice(0, 600) })
    );
  });
}

const inTenant = new Map(); // finding id -> resource exists in the live tenant

const rid = (p) => `${p}-${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 6)}`;

// Simulated log lines per action (what DuploCloud would report).
function simulatedApply(finding) {
  const r = finding.resources[0];
  const t = process.env.DUPLO_TENANT || 'acme-prod';
  switch (finding.action) {
    case 'stop':
      return r.type === 'rds'
        ? [`[duplo] tenant=${t} rds stop ${r.name}`, `[duplo] snapshot ${rid('rds:snap')} created`, `[duplo] ${r.name} status: stopping -> stopped`]
        : [
            `[duplo] tenant=${t} hosts stop ${r.name}`,
            `[duplo] AMI ${rid('ami')} registered (restore point)`,
            `[duplo] EBS snapshot ${rid('snap')} 100% complete`,
            `[duplo] instance ${rid('i')} state: running -> stopping`,
            `[duplo] instance state: stopping -> stopped (billing for compute halted)`,
          ];
    case 'rightsize':
      return [
        `[duplo] tenant=${t} rds set_instance_size ${r.name} db.r6g.xlarge`,
        `[duplo] snapshot ${rid('rds:snap')} created`,
        '[duplo] modifying standby (Multi-AZ) -> db.r6g.xlarge',
        '[duplo] failover complete in 27 s; primary now db.r6g.xlarge',
      ];
    case 'scale':
      return [
        `[duplo] tenant=${t} asg scale ${r.name} desired 6 -> 3`,
        '[duplo] PodDisruptionBudgets OK for 6 workloads',
        '[duplo] cordon + drain node 1/3 ... 2/3 ... 3/3',
        '[duplo] 3 nodes terminated; 0 pods pending',
      ];
    case 'reroute-llm':
      return [
        `[duplo] tenant=${t} service update_env llm-gateway SUPPORT_COPILOT_ROUTE=crusoe/moonshotai/Kimi-K2.6`,
        '[duplo] rolling restart llm-gateway 2/2 ready',
        '[canary] shadow eval 500 tickets: quality 98.6% of baseline, p95 1.4 s',
        '[duplo] route live; closed model kept as fallback for 7 days',
      ];
    case 'delete-volume':
      return [
        ...finding.resources.map((v) => `[duplo] ${v.name}: archive snapshot ${rid('snap')} complete`),
        ...finding.resources.map((v) => `[duplo] ${v.name}: deleted`),
      ];
    case 'decommission':
      return [
        ...finding.resources.filter((x) => !/k8s/.test(x.type)).map((x) => `[duplo] ${x.name}: final snapshot ${rid('snap')} complete`),
        ...finding.resources.filter((x) => /k8s/.test(x.type)).map((x) => `[duplo] tenant=${t} service scale ${x.name} 2 -> 0 replicas`),
        ...finding.resources.filter((x) => !/k8s/.test(x.type)).map((x) => `[duplo] ${x.name}: stopped (billing halted; delete scheduled in 7 days)`),
      ];
    case 'block-public':
      return [
        `[duplo] tenant=${t} s3 ${r.name}: saved policy + ACL to audit log`,
        `[duplo] s3 ${r.name}: BlockPublicAccess=ALL enabled`,
        '[duplo] anonymous GET now returns 403',
      ];
    default:
      return ['[duplo] no-op'];
  }
}

function simulatedRollback(finding) {
  const r = finding.resources[0];
  const map = {
    stop: [`[duplo] ${r.type === 'rds' ? 'rds' : 'hosts'} start ${r.name}`, `[duplo] ${r.name} state: stopped -> running`, '[duplo] health checks passing'],
    rightsize: [`[duplo] rds set_instance_size ${r.name} db.r6g.4xlarge`, '[duplo] failover complete; restored original class'],
    scale: [`[duplo] asg scale ${r.name} desired 3 -> 6`, '[duplo] 3 nodes Ready'],
    'reroute-llm': ['[duplo] service update_env llm-gateway SUPPORT_COPILOT_ROUTE=closed/default', '[duplo] rolling restart complete'],
    'delete-volume': finding.resources.map((v) => `[duplo] restore ${v.name} from archive snapshot (queued, 24-72 h)`),
    'block-public': [`[duplo] s3 ${r.name}: re-applied saved policy + ACL`],
    decommission: finding.resources.map((x) => (/k8s/.test(x.type) ? `[duplo] service scale ${x.name} 0 -> 2 replicas` : `[duplo] ${x.name}: restored from final snapshot`)),
  };
  return map[finding.action] || ['[duplo] no-op'];
}

async function dryRun(finding) {
  const cmds = commandsFor(finding);
  const live = isLive();
  const checks = [];
  const blast = finding.blast;
  checks.push({
    name: 'Blast radius',
    ok: finding.verdict !== 'refuse',
    detail: `${blast.directCount} direct dependents (${blast.engine === 'neo4j' ? 'Neo4j' : 'in-memory graph'})`,
  });
  if (live) {
    // Real calls: prove the tenant is reachable, then look the resource up in it.
    const t = process.env.DUPLO_TENANT;
    const ten = await runDuploctl(['tenant', 'find', t]);
    checks.push({ name: 'DuploCloud tenant', ok: ten.ok, detail: `duploctl tenant find ${t} -> ${ten.ok ? 'reachable (live)' : ten.out}` });
    if (cmds.dryRun) {
      const res = await runDuploctl(cmds.dryRun);
      inTenant.set(finding.id, res.ok);
      checks.push({
        name: 'DuploCloud resource lookup',
        ok: true,
        detail: res.ok ? `${printable(cmds.dryRun)} -> found (live)` : `${printable(cmds.dryRun)} -> not in tenant ${t} (demo resource); execution will be simulated`,
      });
    }
  } else {
    checks.push({ name: 'DuploCloud resource lookup', ok: true, detail: `${printable(cmds.dryRun) || 'duplo API describe'} -> found in tenant (simulated)` });
  }
  const restorable = finding.action !== 'block-public' && finding.action !== 'reroute-llm';
  if (live) {
    // Real mode: only claim what actually happened.
    checks.push({ name: 'Restore point', ok: true, detail: finding.action === 'stop' ? 'stop keeps disks attached; start restores the resource' : 'previous config captured in audit log' });
  } else {
    checks.push({ name: restorable ? 'Snapshot taken' : 'Config saved', ok: true, detail: restorable ? `${rid('snap')} (restore point, simulated)` : 'previous config captured in audit log' });
  }
  checks.push({ name: 'Rollback ready', ok: true, detail: printable(cmds.rollback) || finding.plan?.rollback || 'restore from snapshot' });
  checks.push({ name: 'Policy', ok: finding.verdict !== 'refuse', detail: finding.verdict === 'refuse' ? 'destructive change with dependents: blocked' : 'within budget + change window; human approval required' });
  return { mode: live ? 'duploctl' : 'simulated', checks, passed: checks.every((c) => c.ok), commands: { apply: printable(cmds.apply), rollback: printable(cmds.rollback) } };
}

async function apply(finding) {
  const cmds = commandsFor(finding);
  if (isLive() && cmds.apply && inTenant.get(finding.id)) {
    const res = await runDuploctl(cmds.apply);
    return { mode: 'duploctl', ok: res.ok, log: [`$ ${printable(cmds.apply)}`, ...res.out.split('\n')] };
  }
  const note = isLive()
    ? [cmds.apply ? `[certain] ${finding.resources.map((r) => r.name).join(', ')} is demo data, not in tenant ${process.env.DUPLO_TENANT}; action simulated` : '[certain] no duploctl command for this action; simulated']
    : [];
  return { mode: 'simulated', ok: true, log: [`$ ${printable(cmds.apply) || `duplo ${finding.action} ${finding.resources.map((r) => r.name).join(' ')}`}`, ...note, ...simulatedApply(finding)] };
}

async function rollback(finding) {
  const cmds = commandsFor(finding);
  if (isLive() && cmds.rollback && inTenant.get(finding.id)) {
    const res = await runDuploctl(cmds.rollback);
    return { mode: 'duploctl', ok: res.ok, log: [`$ ${printable(cmds.rollback)}`, ...res.out.split('\n')] };
  }
  return { mode: 'simulated', ok: true, log: [`$ ${printable(cmds.rollback) || 'duplo rollback'}`, ...simulatedRollback(finding)] };
}

module.exports = { isLive, dryRun, apply, rollback, commandsFor };
