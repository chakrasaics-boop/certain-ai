# CertAIn

**Cloud and AI savings you can be certain of.** (Pronounced "certain".)

> **Everyone else asks for permission. We show proof.**
>
> Crusoe reasons. Neo4j proves. A human approves. DuploCloud acts.

CertAIn is a FinOps app built on DuploCloud's agentic automation platform. It audits a startup's cloud spend and its AI spend in one pass, and it proves each fix is safe before it touches anything. Other cost tools stop at a recommendation. For every waste finding, CertAIn shows a Neo4j blast-radius graph of everything that depends on the resource. It runs a dry run, waits for a human to click Approve, and then executes through DuploCloud with one-click rollback. Each card shows **$/month saved** and **kg CO2/month saved** side by side. The agent also shows **what the audit itself cost** on Crusoe (about $0.04) against a hard budget cap, so it can never turn into a runaway $47K agent loop.

Three agents coordinate in a **Band** room: `@Scout` finds the waste, `@SafetyCritic` approves or vetoes each fix, and `@Executor` is recruited only after a human approves.

## Why this is different

| | What they do | What CertAIn adds |
|---|---|---|
| **Vantage** (FinOps Agent) | Cost reporting, recommendations, approval gates | Proof, not just a gate: dependency graph + dry run + rollback on every fix, and AI/token spend next to infra |
| **Sedai** | Autonomous optimization (mostly autopilot for services) | Built for teams that won't run autopilot: a critic agent that can veto, and a human click before anything runs |
| **CAST AI** | Kubernetes rightsizing and autoscaling | Covers the rest of the bill: idle GPUs, RDS, EBS, S3, and closed-model token spend (CAST AI doesn't touch token spend) |
| **Portkey / LiteLLM / Helicone** | LLM gateway, token observability | Acts on the bill: re-routes a closed-model workload to open models on Crusoe, with a canary and a price check against OpenRouter |
| **Carbon dashboards** (Greenpixie, Amnic) | Report CO2 | Changes CO2: every fix carries its kg CO2/month, and executing the fix is what saves it |

Buyer: a seed to Series B CTO with a $20K+/month cloud bill and no FinOps team. Pricing: a percentage of verified monthly savings.

## Sponsor tech: each one does real work

| Sponsor | What it does in CertAIn | Where |
|---|---|---|
| **Crusoe Managed Inference** | `@Scout` plans every fix with **Kimi K2.6** (rationale + fix plan as JSON). `@SafetyCritic` validates safety with **Nemotron 3 Nano**. Tokens and $ are metered per call, and a hard per-audit budget cap applies. Crusoe is also the migration target for the closed-model LLM workload. | `src/llm.js`, `src/audit.js` |
| **DuploCloud** | `@Executor` runs the approved change through `duploctl` (`hosts stop/start`, `rds stop/start/set_instance_size`, `asg scale`, `service update_env`) and rolls it back with one click. The dry run does a real `duploctl ... find` lookup. | `src/executor.js` |
| **Neo4j** | The graph both **finds** and **proves**. Scout's orphan-detection Cypher flags paid resources that have no `DEPENDS_ON` path from any live `:Entrypoint`, and in the demo it finds a dead `recsys-v1 → redis-recsys` chain that metrics miss. SafetyCritic's blast radius uses `[:DEPENDS_ON*1..5]` and reports direct and transitive dependents. `(:Team)-[:OWNS]->()` rolls up waste by team. A Graph tab shows the whole graph and every query. | `src/graph.js`, `scripts/seed-neo4j.js` |
| **Band** | The three agents talk only through a Band room, using @mentions. Scout hands off to Critic, Critic's APPROVE/VETO decides whether anything can run, and Scout adds `@Executor` to the room at runtime (`POST /chats/{id}/participants`) after a human approves. Remove the room and nothing can be approved or executed. | `src/band.js`, `src/agents.js` |
| **OpenRouter** | Live per-token prices from `GET /api/v1/models`. Scout uses them to price the same closed-model workload on open models, next to the Crusoe target. Cached for an hour, with a bundled snapshot as fallback. | `src/openrouter.js` |

The strip at the top of the UI shows **LIVE** or **SIMULATED** for each sponsor. With no env vars set, every integration falls back to a safety net, so the demo never breaks.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Demo mode needs no config. It uses canned reasoning with simulated token accounting, an in-memory graph, an in-process Band room and a simulated DuploCloud tenant.

To go live, set any subset of the env vars below, then run:

```bash
npm run check        # smoke-tests every integration and prints LIVE / SIM / FAIL
npm run models       # GET /v1/models on Crusoe and confirms PLANNER_MODEL / CHECKER_MODEL exist
```

End-to-end UI test with screenshots (Playwright + Chromium):

```bash
PORT=3000 npm start &
BASE_URL=http://localhost:3000 NODE_PATH=$(npm root -g) npm run test:e2e   # writes screenshots/*.png
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CRUSOE_API_KEY` | (unset = demo mode) | Crusoe Managed Inference key |
| `CRUSOE_BASE_URL` | `https://api.inference.crusoecloud.com/v1` | OpenAI-compatible endpoint |
| `PLANNER_MODEL` | `moonshotai/Kimi-K2.6` | Scout's model |
| `CHECKER_MODEL` | `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B` | SafetyCritic's model |
| `PLANNER_PRICE_IN` / `PLANNER_PRICE_OUT` | `1.00` / `3.00` | USD per 1M tokens. Set these to your Crusoe rate card. |
| `CHECKER_PRICE_IN` / `CHECKER_PRICE_OUT` | `0.10` / `0.40` | USD per 1M tokens |
| `AUDIT_BUDGET_USD` | `0.50` | Hard per-audit cap. Once it's reached, calls fall back to canned reasoning. |
| `LLM_TIMEOUT_MS` | `45000` | Per-call timeout |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | (unset = in-memory) | e.g. an AuraDB Free instance (`neo4j+s://...`) |
| `BAND_ROOM_ID` | (unset = in-process room) | Band room created at app.band.ai |
| `BAND_SCOUT_API_KEY` / `BAND_SCOUT_ID` / `BAND_SCOUT_HANDLE` | | Scout's Band agent credentials. Handle format: `@user/agent` |
| `BAND_SAFETY_CRITIC_API_KEY` / `BAND_SAFETY_CRITIC_ID` / `BAND_SAFETY_CRITIC_HANDLE` | | SafetyCritic's credentials |
| `BAND_EXECUTOR_API_KEY` / `BAND_EXECUTOR_ID` / `BAND_EXECUTOR_HANDLE` | | Executor's credentials. Do **not** add Executor to the room yourself: Scout recruits it. |
| `BAND_BASE_URL` / `BAND_POLL_MS` | `https://app.band.ai` / `1200` | |
| `DUPLO_HOST` / `DUPLO_TOKEN` / `DUPLO_TENANT` | (unset = simulated) | DuploCloud portal, token and tenant for `duploctl` (`pip install duplocloud-client`) |
| `DUPLOCTL_BIN` | `duploctl` | Path to the CLI |
| `FRONTIER_MODEL` | `openai/gpt-6-astra` | Closed model used for the "N× cheaper" comparison |
| `OPENROUTER_MODELS_URL` | `https://openrouter.ai/api/v1/models` | Public, no key needed |
| `DEMO_SPEED` | `1` | Speeds up canned pacing (tests) |
| `PORT` | `3000` | |

## Architecture

```
                     Browser (plain HTML/CSS/JS, cytoscape.js)
     counters · integrations strip · Band room · findings · blast-radius graph
                 |  POST /api/audit, /dryrun, /approve, /rollback
                 |  GET  /api/events  (one SSE stream: room msgs, findings, meter)
                 v
   +------------------------------ Express (server.js) ------------------------------+
   |                                                                                 |
   |   Band room  (src/band.js)   app.band.ai REST  |  in-process bus (same routing)  |
   |   +------------------------------------------------------------------------+   |
   |   |  @Scout ----- "review ref:f1" ------------> @SafetyCritic               |   |
   |   |  @Scout <---- "APPROVE ref:f1" / "VETO" --- @SafetyCritic               |   |
   |   |  @Scout ----- "dry-run ref:f1" ------------> @SafetyCritic              |   |
   |   |  human Approve -> Scout adds @Executor to the room (runtime recruit)    |   |
   |   |  @Scout ----- "execute ref:f1 SafetyCritic:APPROVE" --> @Executor       |   |
   |   |  @Scout <---- "DONE ref:f1" / "ROLLED-BACK" ---------- @Executor        |   |
   |   +------------------------------------------------------------------------+   |
   |        |                          |                           |                 |
   |   detectors.js (rules)       graph.js                    executor.js            |
   |   llm.js planner   ------>   Neo4j Cypher                duploctl (live)        |
   |   (Kimi K2.6 on Crusoe)      or in-memory BFS            or simulated tenant    |
   |   openrouter.js prices       llm.js checker (Nemotron)   + rollback             |
   |   co2.js kWh x PUE x grid    + deterministic policy                             |
   +---------------------------------------------------------------------------------+
                 data/acme-env.json: seeded "Acme AI" (26 resources, 26 edges, 6 entrypoints, 6 teams)
```

### Safety model
1. **Blast radius (Neo4j).** A destructive action (`stop`, `delete`) on anything with a direct dependent gets a **VETO**. This rule is deterministic. The Nemotron checker can add caution, but it can never override a veto.
2. **Dry run.** A DuploCloud lookup, a restore point and a rollback command must all be green.
3. **Human approval.** Only for approved findings whose dry run passed. A vetoed finding has no Approve button, and the API returns 409.
4. **Execution.** `@Executor` refuses any handoff that doesn't cite SafetyCritic's APPROVE. Every action has a rollback.

### Try it on your bill
Click **Try it on your bill** and drop in an AWS Cost Explorer export, a CUR CSV, or any CSV with service, resource, usage and cost columns. Columns are detected automatically, including CUR `lineItem/*` headers and Cost Explorer's wide `Service($)` layout. You can also click **Use sample bill** (`data/sample-bill.csv`, a 40-line CUR for a $39K/mo startup).

Deterministic detectors flag waste in these areas:
- idle or under-used compute and GPUs
- unattached EBS volumes and idle Elastic IPs
- old snapshots
- NAT Gateway and data-transfer spend
- closed-model LLM API spend, priced on Crusoe and via OpenRouter

The panel shows waste in $/mo and as a % of the bill, a CO2 estimate, and the top 5 cards. **Prove & fix** sends a card whose resource exists in the connected environment into the blast-radius, critic and approval flow. For any other resource it says "Connect DuploCloud to act".

The CSV is parsed by the local CertAIn server and raw rows are never uploaded. In live mode, only the top findings' titles and dollar totals go to Crusoe for the Scout's summary.

### Approving from the Band room
Besides the UI button, a human participant in the Band room can approve by posting `@Scout approve f1`. Scout applies the same gates (SafetyCritic APPROVE plus a passing dry run), then recruits `@Executor`. In in-process mode, the **Judge approves via Band** button posts that message as a human participant.

### Audit cost vs a frontier model
The "This audit cost" tile prices the audit's own tokens at a flagship closed model's OpenRouter list price. That's `FRONTIER_MODEL`, default `openai/gpt-6-astra`, using live prices or the bundled snapshot. The tile shows "N× cheaper than <model>", and the math is in its tooltip.

### The graph (Neo4j)
Model: `(:WPResource)-[:DEPENDS_ON {kind}]->(:WPResource)`, where a dependent points to its dependency. `:Entrypoint` is an extra label on anything that receives live traffic (DNS, load balancer, CDN, webhook, schedule), and `(:Team)-[:OWNS]->(:WPResource)` records ownership. There are four queries, all in `src/graph.js` and all shown in the UI's **Graph** tab:

1. **Orphan detection (a Scout detector).** It returns paid resources with `NOT EXISTS { MATCH (:Entrypoint)-[:DEPENDS_ON*1..8]->(r) }`. Connected orphans are grouped into one finding labeled **Found by graph**. Metric findings that the graph also confirms get a **Graph-confirmed** chip.
2. **Blast radius (the SafetyCritic gate).** `(t)<-[:DEPENDS_ON*1..5]-(d)` with `min(length(p))` as the hop count. It lists direct and transitive dependents. A destructive action with any direct dependent outside the finding's own resource set is vetoed.
3. **Team rollup.** `MATCH (t:Team)-[:OWNS]->(r) RETURN t.name, sum(r.monthlyCost), sum(r.wasteMonthly)`. After each audit, the actionable waste is written back onto the nodes (`wasteMonthly`).
4. **Load.** Uniqueness constraints on `WPResource.id` and `Team.name`, then `MERGE` of nodes, labels, owners and edges.

Seed an AuraDB Free instance and run all the queries against it:

```bash
NEO4J_URI=neo4j+s://<id>.databases.neo4j.io NEO4J_USER=neo4j NEO4J_PASSWORD=... npm run seed:neo4j
```

Without Neo4j, an in-memory implementation of the same queries (BFS with the same hop limits) returns identical shapes, so the demo never breaks.

### Proof receipt
Every executed, rolled-back or vetoed fix gets a **Proof receipt** card with a short ID (`CRT-XXXXXXXX`, the first 8 hex characters of a SHA-256 over the receipt body). It records:
- the blast-radius result (dependent count and the Cypher that was run)
- the SafetyCritic verdict and its Band message ID
- the dry-run checks
- who approved it and when
- the DuploCloud command and the rollback handle
- $/month and kg CO2/month

**Download receipt** saves it as JSON (`GET /api/findings/:id/receipt?download=1`).

### CO2 method
Energy (kWh/month) × PUE (1.135) × grid intensity (us-east-1: 0.379 kg/kWh). Compute uses average watts. Storage uses 1.2 Wh/TB-h × replication 2. LLM workloads use Wh per 1K tokens for a closed model vs an open MoE, with an assumed Crusoe grid intensity. All assumptions appear in the UI tooltips and live in `src/co2.js`. These are estimates, not meter readings.

## Demo script (2 minutes)
1. **Run audit.** Findings stream into the Band room, and the tok/s and "$0.04 on Crusoe" readouts tick.
2. **Idle GPU** (`gpu-finetune-01`, $3,104/mo, 0% for 14 days). The graph shows **0 dependents**.
3. **Run dry run.** Checks turn green: snapshot taken, rollback ready.
4. **Approve and execute via DuploCloud.** `@Executor` joins the room, the log streams, and the counters show **$3,104/mo** and **100.5 kg CO2/mo**.
5. **Low-traffic database** (`rds-legacy-billing`). **3 services depend on it** (billing-api, invoice-worker, stripe-webhook). SafetyCritic vetoes it, so there's no Approve button, only the reason.
Tip: to open on the refusal, load `http://localhost:3000/?focus=veto`, which auto-selects the vetoed database as soon as it's found. You can also press **v** or click **Show veto** in the Findings header.

6. Optional: **Closed-model token spend.** OpenRouter prices vs the Crusoe target.

## Honest notes
- The seeded account is fictional. The metrics and prices in `data/acme-env.json` are illustrative.
- The `duploctl` subcommands are mapped in `commandsFor()` in `src/executor.js`. Check them against `duploctl <resource> --help` for your portal version. Actions with no `duploctl` equivalent (EBS delete, S3 Block Public Access) are simulated even in live mode, and the log says so.
- In demo mode, token counts and cost are simulated to match typical live prompt sizes. With `CRUSOE_API_KEY` set, the numbers come from the API's `usage` field.
