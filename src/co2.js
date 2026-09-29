// CO2 estimation: energy (kWh/month) x datacenter PUE x grid carbon intensity.
// Coefficients follow the Cloud Carbon Footprint methodology where possible and are
// deliberately simple and visible: every estimate returns the assumptions it used.

const HOURS_PER_MONTH = 730;

const ASSUMPTIONS = {
  pue: { value: 1.135, source: 'AWS-reported PUE (CCF default)' },
  grid: {
    'us-east-1': { value: 0.379, unit: 'kg CO2e/kWh', source: 'PJM / Virginia grid mix (CCF, eGRID)' },
    crusoe: { value: 0.12, unit: 'kg CO2e/kWh', source: 'Assumed for Crusoe energy-first sites (wind / stranded-gas capture); conservative placeholder' },
    global: { value: 0.379, unit: 'kg CO2e/kWh', source: 'Fallback to us-east-1 intensity' },
  },
  ssdWhPerTBh: { value: 1.2, source: 'CCF SSD storage coefficient' },
  ebsReplication: { value: 2, source: 'CCF replication factor for EBS' },
  closedModelWhPer1kTok: { value: 0.40, source: 'Estimate for a frontier dense model on shared GPU fleet' },
  openModelWhPer1kTok: { value: 0.15, source: 'Estimate for a sparse MoE (few B active params) with batched vLLM serving' },
};

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const gridFor = (region) => (ASSUMPTIONS.grid[region] || ASSUMPTIONS.grid.global).value;

function computeEnergy(watts) {
  return (watts * HOURS_PER_MONTH) / 1000 * ASSUMPTIONS.pue.value; // kWh/month at the meter
}

/**
 * Estimate monthly CO2 saved by a fix.
 * @param {object} r resource
 * @param {string} action stop|rightsize|scale|delete-volume|reroute-llm|block-public
 */
function estimateSavings(r, action) {
  const grid = gridFor(r.region);
  const lines = [];
  let kwhBefore = 0;
  let kwhAfter = 0;
  let kgBefore;
  let kgAfter;

  switch (action) {
    case 'decommission':
    case 'stop': {
      kwhBefore = computeEnergy(r.power?.avgWatts || 0);
      kwhAfter = 0;
      lines.push(`${r.power?.avgWatts} W average draw x 730 h x PUE ${ASSUMPTIONS.pue.value}`);
      break;
    }
    case 'rightsize':
    case 'scale': {
      kwhBefore = computeEnergy(r.power?.avgWatts || 0);
      kwhAfter = computeEnergy(r.power?.targetWatts || 0);
      lines.push(`${r.power?.avgWatts} W -> ${r.power?.targetWatts} W x 730 h x PUE ${ASSUMPTIONS.pue.value}`);
      break;
    }
    case 'delete-volume': {
      const tb = r.metrics?.sizeTB || 0;
      kwhBefore = (tb * ASSUMPTIONS.ssdWhPerTBh.value * ASSUMPTIONS.ebsReplication.value * HOURS_PER_MONTH) / 1000 * ASSUMPTIONS.pue.value;
      lines.push(`${tb} TB x ${ASSUMPTIONS.ssdWhPerTBh.value} Wh/TB-h x replication ${ASSUMPTIONS.ebsReplication.value} x 730 h x PUE`);
      break;
    }
    case 'reroute-llm': {
      const ktok = (r.metrics?.tokensPerMonthM || 0) * 1000;
      kwhBefore = (ktok * ASSUMPTIONS.closedModelWhPer1kTok.value) / 1000;
      kwhAfter = (ktok * ASSUMPTIONS.openModelWhPer1kTok.value) / 1000;
      kgBefore = kwhBefore * grid;
      kgAfter = kwhAfter * ASSUMPTIONS.grid.crusoe.value;
      lines.push(`${r.metrics.tokensPerMonthM}M tokens x ${ASSUMPTIONS.closedModelWhPer1kTok.value} Wh/1k (closed) vs ${ASSUMPTIONS.openModelWhPer1kTok.value} Wh/1k (open MoE)`);
      lines.push(`Grid: ${grid} (${r.region}) -> ${ASSUMPTIONS.grid.crusoe.value} kg/kWh (Crusoe, assumed)`);
      break;
    }
    case 'block-public': {
      // Egress reduction only; tiny but real network energy (0.001 kWh/GB, CCF networking coefficient).
      kwhBefore = (r.metrics?.egressGBMonth || 0) * 0.001;
      lines.push(`${r.metrics?.egressGBMonth} GB/month anonymous egress x 0.001 kWh/GB (CCF networking)`);
      break;
    }
    default:
      break;
  }
  if (kgBefore === undefined) kgBefore = kwhBefore * grid;
  if (kgAfter === undefined) kgAfter = kwhAfter * grid;
  if (action !== 'reroute-llm') lines.push(`Grid intensity ${grid} kg CO2e/kWh (${r.region})`);

  return {
    kwhSaved: round(kwhBefore - kwhAfter, 1),
    kgSaved: round(kgBefore - kgAfter, 1),
    assumptions: lines,
  };
}

module.exports = { estimateSavings, ASSUMPTIONS };
