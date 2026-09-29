// Deterministic waste detectors. They are cheap, explainable and never hallucinate:
// the LLM planner only writes rationale + fix plans for what these rules surface,
// and the policy guard (not the LLM) has the final word on safety.
//
// Each candidate also carries canned reasoning used in demo mode or when the LLM
// call fails, so the demo never breaks.

const { MODELS } = require('./llm');

// Crusoe cost for an LLM workload at the planner model's rate card (env-configurable).
const crusoeMonthly = (r) =>
  Math.round(r.metrics.tokensPerMonthM * (r.metrics.inputShare * MODELS.planner.priceIn + (1 - r.metrics.inputShare) * MODELS.planner.priceOut));

const fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');

const DETECTORS = [
  {
    key: 'idle-gpu',
    priority: 1,
    match: (r) => r.type === 'ec2-gpu' && r.metrics?.gpuUtilMax === 0 && (r.metrics?.idleDays || 0) >= 7,
    build: (r) => ({
      category: 'AI infra',
      title: 'Idle GPU instance',
      summary: `0% GPU utilization for ${r.metrics.idleDays} days · ${fmt(r.monthlyCost)}/mo`,
      action: 'stop',
      actionLabel: 'Snapshot + stop instance',
      destructive: true,
      monthlySavings: r.monthlyCost,
      canned: {
        headline: `Stop ${r.name}: an L40S box nobody has touched in ${r.metrics.idleDays} days`,
        rationale: `GPU utilization has been exactly 0% (max 0%) for the full ${r.metrics.idleDays}-day window, CPU averages ${r.metrics.cpuUtilAvg}%, inbound traffic is ~${r.metrics.netInGBDay} GB/day and the last SSH login was ${r.metrics.lastSsh}. It is tagged to a finished Q2 fine-tuning project. Stopping it removes ${fmt(r.monthlyCost)}/mo of compute while the EBS snapshot and AMI keep the environment one click away.`,
        plan: [
          'Create EBS snapshot + AMI of gpu-finetune-01 (restore point)',
          'Tag instance certain:stopped=true, notify owner ml-research',
          'Stop instance through DuploCloud (no termination)',
          'Notify #ml-research with restart command; auto-expire snapshot in 30 days',
        ],
        rollback: 'Start the instance from DuploCloud; the snapshot covers disk loss.',
        risk: 'low',
        confidence: 0.97,
      },
    }),
  },
  {
    key: 'idle-db',
    priority: 2,
    match: (r) => r.type === 'rds' && r.metrics?.cpuUtilAvg < 3 && r.metrics?.queriesPerMin < 50,
    build: (r) => ({
      category: 'Infra',
      title: 'Low-traffic database',
      summary: `${r.metrics.cpuUtilAvg}% CPU, ${r.metrics.queriesPerMin} queries/min · ${fmt(r.monthlyCost)}/mo`,
      action: 'stop',
      actionLabel: 'Snapshot + stop database',
      destructive: true,
      monthlySavings: r.monthlyCost,
      canned: {
        headline: `${r.name} looks idle, but it is still wired into billing`,
        rationale: `Average CPU is ${r.metrics.cpuUtilAvg}% with ~${r.metrics.queriesPerMin} queries/min, which usually means an abandoned database. The dependency graph disagrees: billing-api reads and writes it, invoice-worker reads it nightly, and the stripe-webhook Lambda writes payment events to it. Low traffic is expected for a payments ledger; stopping it would break invoicing and drop Stripe webhooks.`,
        plan: [
          'Do NOT stop or delete: 3 live services depend on this database',
          'Open a ticket for #payments to confirm ownership and expected load',
          'Revisit as a rightsizing candidate (db.t4g.large) after owner review',
        ],
        rollback: 'No action taken.',
        risk: 'high',
        confidence: 0.93,
      },
    }),
  },
  {
    key: 'closed-model-spend',
    priority: 3,
    match: (r) => r.type === 'llm-service' && (r.metrics?.tokensPerMonthM || 0) > 100,
    build: (r) => ({
      category: 'AI spend',
      title: 'Closed-model token spend',
      summary: `${r.metrics.tokensPerMonthM}M tokens/mo on a closed model · ${fmt(r.monthlyCost)}/mo`,
      action: 'reroute-llm',
      actionLabel: 'Re-route to open model on Crusoe (canary)',
      destructive: false,
      monthlySavings: r.monthlyCost - crusoeMonthly(r),
      canned: {
        headline: `Move support-copilot to an open model on Crusoe Managed Inference`,
        rationale: `support-copilot sends ${r.metrics.tokensPerMonthM}M tokens/mo (${Math.round(r.metrics.inputShare * 100)}% input, ~${r.metrics.avgPromptTokens} tokens per prompt) to a closed frontier model. The workload is retrieval-grounded ticket drafting, which open models handle well. Routing it through llm-gateway to Kimi-K2.6 on Crusoe cuts spend from ${fmt(r.monthlyCost)} to ~${fmt(crusoeMonthly(r))}/mo and moves the tokens onto energy-first compute.`,
        plan: [
          'Shadow 5% of traffic to Kimi-K2.6 on Crusoe; score with the existing eval set',
          'Gate: answer quality within 2% of baseline and p95 latency under 2.5 s',
          'Flip llm-gateway route for support-copilot to Crusoe (config change only)',
          'Keep the closed model as automatic fallback for 7 days',
        ],
        rollback: 'Restore the previous llm-gateway route (one env var).',
        risk: 'medium',
        confidence: 0.86,
      },
    }),
  },
  {
    key: 'oversized-db',
    priority: 4,
    match: (r) => r.type === 'rds' && r.targetSpec && r.metrics?.cpuUtilMax < 20 && r.metrics?.memUsedPct < 30,
    build: (r) => ({
      category: 'Infra',
      title: 'Oversized database',
      summary: `Peak CPU ${r.metrics.cpuUtilMax}%, memory ${r.metrics.memUsedPct}% · ${fmt(r.monthlyCost)}/mo`,
      action: 'rightsize',
      actionLabel: `Rightsize to ${r.targetSpec.split(' ·')[0]}`,
      destructive: false,
      monthlySavings: r.monthlyCost - r.targetMonthlyCost,
      canned: {
        headline: `Rightsize ${r.name} from 4xlarge to xlarge`,
        rationale: `Over 14 days CPU peaked at ${r.metrics.cpuUtilMax}% and memory at ${r.metrics.memUsedPct}% on a db.r6g.4xlarge. A db.r6g.xlarge keeps >2x headroom over the observed peak. Multi-AZ means the resize applies to the standby first, then fails over, with ~30 s of reconnects for its single consumer (metabase).`,
        plan: [
          'Take manual snapshot',
          'Modify instance class to db.r6g.xlarge in the Sunday maintenance window',
          'Watch CPU and p95 query latency for 24 h; alert threshold 70% CPU',
        ],
        rollback: 'Modify instance class back to db.r6g.4xlarge.',
        risk: 'medium',
        confidence: 0.9,
      },
    }),
  },
  {
    key: 'overprovisioned-nodegroup',
    priority: 5,
    match: (r) => r.type === 'k8s-nodegroup' && r.metrics?.cpuRequestedPct < 40,
    build: (r) => ({
      category: 'Kubernetes',
      title: 'Over-provisioned node group',
      summary: `${r.metrics.nodes} nodes, ${r.metrics.cpuRequestedPct}% CPU requested · ${fmt(r.monthlyCost)}/mo`,
      action: 'scale',
      actionLabel: `Scale ${r.metrics.nodes} -> ${r.targetNodes} nodes`,
      destructive: false,
      monthlySavings: r.monthlyCost - r.targetMonthlyCost,
      canned: {
        headline: `Scale ng-cpu-general from ${r.metrics.nodes} to ${r.targetNodes} nodes`,
        rationale: `Pods request only ${r.metrics.cpuRequestedPct}% of CPU and ${r.metrics.memRequestedPct}% of memory across ${r.metrics.nodes} m5.4xlarge nodes. Bin-packing onto ${r.targetNodes} nodes leaves 26% CPU headroom. Six workloads run here, so the drain must respect PodDisruptionBudgets.`,
        plan: [
          'Verify PodDisruptionBudgets for all 6 workloads',
          'Cordon and drain 3 nodes one at a time',
          `Set node group desired/min to ${r.targetNodes}, max stays at 8 for autoscaling`,
        ],
        rollback: `Set desired back to ${r.metrics.nodes}; cluster autoscaler reschedules.`,
        risk: 'medium',
        confidence: 0.88,
      },
    }),
  },
  {
    key: 'orphaned-volumes',
    priority: 6,
    group: true,
    match: (r) => r.type === 'ebs' && r.metrics?.attached === false && r.metrics?.detachedDays > 30,
    build: (rs) => ({
      category: 'Storage',
      title: `${rs.length} orphaned EBS volumes`,
      summary: `Unattached ${Math.min(...rs.map((r) => r.metrics.detachedDays))}-${Math.max(...rs.map((r) => r.metrics.detachedDays))} days · ${fmt(rs.reduce((a, r) => a + r.monthlyCost, 0))}/mo`,
      action: 'delete-volume',
      actionLabel: 'Snapshot to cold tier + delete',
      destructive: true,
      monthlySavings: rs.reduce((a, r) => a + r.monthlyCost, 0) - 21,
      canned: {
        headline: `Delete ${rs.length} volumes that have not been attached for 47-133 days`,
        rationale: `${rs.map((r) => r.name).join(', ')} are unattached and have no dependents. The 2 TB io1 volume alone pays for 10k provisioned IOPS nobody uses. Snapshots in the archive tier cost ~$21/mo and keep the data recoverable.`,
        plan: ['Snapshot each volume to EBS Snapshots Archive', 'Delete the volumes', 'Keep snapshots 90 days, then expire'],
        rollback: 'Restore volumes from archive snapshots (24-72 h restore).',
        risk: 'low',
        confidence: 0.95,
      },
    }),
  },
  {
    key: 'public-bucket',
    priority: 7,
    match: (r) => r.type === 's3' && r.metrics?.publicRead === true,
    build: (r) => ({
      category: 'Security',
      title: 'Public S3 bucket',
      summary: `public-read, ${r.metrics.anonymousGetsPerDay.toLocaleString()} anonymous GETs/day · ${r.metrics.egressGBMonth} GB egress/mo`,
      action: 'block-public',
      actionLabel: 'Enable Block Public Access',
      destructive: false,
      monthlySavings: r.egressMonthlyCost,
      canned: {
        headline: 'Close public access on acme-ml-datasets',
        rationale: `The bucket is public-read and contains a customer-transcripts sample. It serves ${r.metrics.anonymousGetsPerDay.toLocaleString()} anonymous GETs per day and nothing in the graph reads it through a public URL. Closing it is a security fix first and removes ~${r.metrics.egressGBMonth} GB/mo of egress.`,
        plan: ['Save current bucket policy and ACL', 'Enable S3 Block Public Access', 'Grant ml-research role read via IAM'],
        rollback: 'Re-apply the saved policy and ACL.',
        risk: 'low',
        confidence: 0.96,
      },
    }),
  },
];

function detect(env) {
  const out = [];
  for (const d of DETECTORS) {
    const hits = env.resources.filter(d.match);
    if (!hits.length) continue;
    if (d.group) out.push({ key: d.key, priority: d.priority, resources: hits, ...d.build(hits) });
    else hits.forEach((r) => out.push({ key: d.key, priority: d.priority, resources: [r], ...d.build(r) }));
  }
  return out.sort((a, b) => a.priority - b.priority);
}

// Candidate discovered by the graph itself: an orphan component with no path from any entrypoint.
function graphCandidate(group, env, orphanResult) {
  const rs = group.map((o) => env.resources.find((r) => r.id === o.id));
  const names = rs.map((r) => r.name).join(' + ');
  const cost = rs.reduce((a, r) => a + (r.monthlyCost || 0), 0);
  const svc = rs.find((r) => /k8s/.test(r.type));
  return {
    key: 'graph-orphan',
    priority: 2.5,
    foundBy: 'graph',
    resources: rs,
    category: 'Orphan',
    title: rs.length > 1 ? 'Orphaned service chain' : 'Orphaned resource',
    summary: `No path from any of ${orphanResult.entrypoints.length} live entrypoints · ${fmt(cost)}/mo`,
    action: 'decommission',
    actionLabel: svc ? `Scale ${svc.name} to 0 + snapshot and remove the rest` : 'Snapshot + decommission',
    destructive: true,
    monthlySavings: cost,
    canned: {
      headline: `${names}: running, billed, and unreachable`,
      rationale: `No metric looks alarming here (CPU ${rs.map((r) => `${r.name} ${r.metrics?.cpuUtilAvg ?? '?'}%`).join(', ')}), so utilization detectors pass it. The graph shows the real problem: there is no DEPENDS_ON path from any live entrypoint (${orphanResult.entrypoints.join(', ')}) to ${names}. ${svc?.tags?.['deprecated-by'] ? `${svc.name} is tagged deprecated-by "${svc.tags['deprecated-by']}". ` : ''}Nothing that serves users can reach it.`,
      plan: [
        `Snapshot ${rs.filter((r) => !/k8s/.test(r.type)).map((r) => r.name).join(', ') || 'state'} (restore point)`,
        svc ? `Scale ${svc.name} to 0 replicas (manifest kept)` : 'Stop the resource',
        'Watch for 7 days: any inbound call re-scales automatically',
        'Delete after the quiet period; notify the owning team',
      ],
      rollback: svc ? `Scale ${svc.name} back to its previous replica count; restore from snapshot.` : 'Restore from snapshot.',
      risk: 'low',
      confidence: 0.9,
    },
  };
}

module.exports = { detect, graphCandidate, DETECTORS };
