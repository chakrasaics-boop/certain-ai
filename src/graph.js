// Resource dependency graph: the part of CertAIn that FINDS and PROVES.
//
// Model:  (:WPResource)-[:DEPENDS_ON {kind}]->(:WPResource)   dependent -> dependency
//         (:WPResource:Entrypoint)  receives live traffic (DNS, LB, CDN, webhook, schedule)
//         (:Team)-[:OWNS]->(:WPResource)
//
// Neo4j when NEO4J_URI/NEO4J_USER/NEO4J_PASSWORD are set; otherwise an in-memory
// implementation of the same queries that returns exactly the same shapes.

const QUERIES = {
  blastRadius: `// Blast radius: everything that transitively depends on the target
MATCH (t:WPResource {id: $id})
OPTIONAL MATCH p = (t)<-[:DEPENDS_ON*1..5]-(d:WPResource)
WITH d, min(length(p)) AS hops
RETURN d.id AS id, d.name AS name, d.type AS type, hops
ORDER BY hops, name`,
  orphans: `// Orphan detection: paid resources with no path from any live entrypoint
MATCH (r:WPResource)
WHERE NOT r:Entrypoint AND r.monthlyCost > 0
  AND NOT EXISTS { MATCH (:Entrypoint)-[:DEPENDS_ON*1..8]->(r) }
RETURN r.id AS id, r.name AS name, r.type AS type, r.monthlyCost AS monthlyCost
ORDER BY monthlyCost DESC`,
  teamRollup: `// Cost and waste rollup by owning team
MATCH (t:Team)-[:OWNS]->(r:WPResource)
RETURN t.name AS team, count(r) AS resources,
       sum(r.monthlyCost) AS spend, sum(coalesce(r.wasteMonthly, 0)) AS waste
ORDER BY waste DESC, spend DESC`,
  setWaste: `// Write the audit's actionable waste back onto the graph
MATCH (r:WPResource) SET r.wasteMonthly = 0
WITH count(*) AS _
UNWIND $rows AS row
MATCH (r:WPResource {id: row.id}) SET r.wasteMonthly = row.waste`,
};

const CONSTRAINTS = [
  'CREATE CONSTRAINT wp_resource_id IF NOT EXISTS FOR (r:WPResource) REQUIRE r.id IS UNIQUE',
  'CREATE CONSTRAINT wp_team_name IF NOT EXISTS FOR (t:Team) REQUIRE t.name IS UNIQUE',
];

const toNum = (v) => (v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));

class ResourceGraph {
  constructor(env) {
    this.env = env;
    this.byId = new Map(env.resources.map((r) => [r.id, r]));
    this.driver = null;
    this.engine = 'in-memory';
    this.status = 'Neo4j not configured: using in-memory traversal';
    this.waste = new Map();
  }

  async init() {
    const { NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD } = process.env;
    if (!NEO4J_URI || !NEO4J_USER || !NEO4J_PASSWORD) return this;
    try {
      const neo4j = require('neo4j-driver');
      this.driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
      await this.driver.verifyConnectivity();
      await this.load();
      this.engine = 'neo4j';
      this.status = `Neo4j connected (${NEO4J_URI}); ${this.env.resources.length} resources, ${this.env.edges.length} DEPENDS_ON edges loaded`;
    } catch (err) {
      this.status = `Neo4j unavailable (${err.message.split('\n')[0]}): using in-memory traversal`;
      if (this.driver) await this.driver.close().catch(() => {});
      this.driver = null;
    }
    return this;
  }

  async run(cypher, params = {}) {
    const session = this.driver.session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  async load() {
    for (const c of CONSTRAINTS) await this.run(c);
    await this.run('MATCH (t:Team)-[:OWNS]->(:WPResource) DETACH DELETE t');
    await this.run('MATCH (n:WPResource) DETACH DELETE n');
    const rows = this.env.resources.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      provider: r.provider,
      monthlyCost: r.monthlyCost || 0,
      owner: r.owner || 'unowned',
      entrypoint: Boolean(r.entrypoint),
    }));
    await this.run(
      `UNWIND $rows AS r
       MERGE (n:WPResource {id: r.id})
       SET n.name = r.name, n.type = r.type, n.provider = r.provider, n.monthlyCost = r.monthlyCost, n.wasteMonthly = 0
       FOREACH (_ IN CASE WHEN r.entrypoint THEN [1] ELSE [] END | SET n:Entrypoint)
       MERGE (t:Team {name: r.owner})
       MERGE (t)-[:OWNS]->(n)`,
      { rows }
    );
    await this.run(
      `UNWIND $edges AS e
       MATCH (a:WPResource {id: e.from}), (b:WPResource {id: e.to})
       MERGE (a)-[rel:DEPENDS_ON]->(b) SET rel.kind = e.kind`,
      { edges: this.env.edges }
    );
  }

  // ---------- blast radius ----------
  inMemoryDependents(id) {
    const seen = new Map();
    let frontier = [id];
    for (let hops = 1; frontier.length && hops <= 5; hops++) {
      const next = [];
      for (const target of frontier) {
        for (const e of this.env.edges) {
          if (e.to === target && e.from !== id && !seen.has(e.from)) {
            seen.set(e.from, hops);
            next.push(e.from);
          }
        }
      }
      frontier = next;
    }
    return [...seen.entries()].map(([did, hops]) => {
      const r = this.byId.get(did);
      return { id: did, name: r.name, type: r.type, hops };
    });
  }

  async blastRadius(id) {
    const started = Date.now();
    let dependents;
    let engine = this.engine;
    if (this.driver) {
      try {
        const res = await this.run(QUERIES.blastRadius, { id });
        dependents = res.records.filter((rec) => rec.get('id')).map((rec) => ({ id: rec.get('id'), name: rec.get('name'), type: rec.get('type'), hops: toNum(rec.get('hops')) }));
      } catch (err) {
        engine = 'in-memory';
        dependents = this.inMemoryDependents(id);
      }
    } else {
      dependents = this.inMemoryDependents(id);
    }

    // Sub-graph for the visualisation: target, its dependents, and its own direct dependencies.
    const ids = new Set([id, ...dependents.map((d) => d.id)]);
    this.env.edges.filter((e) => e.from === id).forEach((e) => ids.add(e.to));
    const nodes = [...ids].map((nid) => {
      const r = this.byId.get(nid);
      const dep = dependents.find((d) => d.id === nid);
      return { id: nid, name: r.name, type: r.type, role: nid === id ? 'target' : dep ? (dep.hops === 1 ? 'direct' : 'indirect') : 'dependency' };
    });
    const edges = this.env.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return {
      engine,
      cypher: QUERIES.blastRadius,
      params: { id },
      ms: Date.now() - started,
      directCount: dependents.filter((d) => d.hops === 1).length,
      totalCount: dependents.length,
      dependents,
      nodes,
      edges,
    };
  }

  // ---------- orphan detection (the graph finds waste) ----------
  inMemoryOrphans() {
    const reached = new Set();
    let frontier = this.env.resources.filter((r) => r.entrypoint).map((r) => r.id);
    for (let hops = 1; frontier.length && hops <= 8; hops++) {
      const next = [];
      for (const f of frontier) {
        for (const e of this.env.edges) {
          if (e.from === f && !reached.has(e.to)) {
            reached.add(e.to);
            next.push(e.to);
          }
        }
      }
      frontier = next;
    }
    return this.env.resources
      .filter((r) => !r.entrypoint && (r.monthlyCost || 0) > 0 && !reached.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, type: r.type, monthlyCost: r.monthlyCost }))
      .sort((a, b) => b.monthlyCost - a.monthlyCost);
  }

  async orphans() {
    const started = Date.now();
    let rows;
    let engine = this.engine;
    if (this.driver) {
      try {
        const res = await this.run(QUERIES.orphans);
        rows = res.records.map((rec) => ({ id: rec.get('id'), name: rec.get('name'), type: rec.get('type'), monthlyCost: toNum(rec.get('monthlyCost')) }));
      } catch (err) {
        engine = 'in-memory';
        rows = this.inMemoryOrphans();
      }
    } else rows = this.inMemoryOrphans();

    // Connected components among orphans (a dead service and the cache only it uses = one finding).
    const ids = new Set(rows.map((r) => r.id));
    const comp = new Map();
    let n = 0;
    for (const r of rows) {
      if (comp.has(r.id)) continue;
      const stack = [r.id];
      comp.set(r.id, n);
      while (stack.length) {
        const cur = stack.pop();
        for (const e of this.env.edges) {
          const other = e.from === cur ? e.to : e.to === cur ? e.from : null;
          if (other && ids.has(other) && !comp.has(other)) {
            comp.set(other, n);
            stack.push(other);
          }
        }
      }
      n++;
    }
    const groups = [...Array(n).keys()].map((k) => rows.filter((r) => comp.get(r.id) === k));
    const entrypoints = this.env.resources.filter((r) => r.entrypoint).map((r) => r.name);
    return { engine, cypher: QUERIES.orphans, ms: Date.now() - started, orphans: rows, groups, entrypoints };
  }

  // ---------- team rollup ----------
  async setWaste(map) {
    this.waste = new Map(map);
    if (this.driver) {
      await this.run(QUERIES.setWaste, { rows: [...map.entries()].map(([id, waste]) => ({ id, waste })) }).catch(() => {});
    }
  }

  async teamRollup() {
    const started = Date.now();
    if (this.driver) {
      try {
        const res = await this.run(QUERIES.teamRollup);
        const rows = res.records.map((rec) => ({ team: rec.get('team'), resources: toNum(rec.get('resources')), spend: toNum(rec.get('spend')), waste: toNum(rec.get('waste')) }));
        return { engine: 'neo4j', cypher: QUERIES.teamRollup, ms: Date.now() - started, rows };
      } catch (err) {
        /* fall through to in-memory */
      }
    }
    const teams = new Map();
    for (const r of this.env.resources) {
      const t = r.owner || 'unowned';
      const row = teams.get(t) || { team: t, resources: 0, spend: 0, waste: 0 };
      row.resources++;
      row.spend += r.monthlyCost || 0;
      row.waste += this.waste.get(r.id) || 0;
      teams.set(t, row);
    }
    const rows = [...teams.values()].sort((a, b) => b.waste - a.waste || b.spend - a.spend);
    return { engine: 'in-memory', cypher: QUERIES.teamRollup, ms: Date.now() - started, rows };
  }

  // ---------- full graph for the Graph tab ----------
  full() {
    return {
      nodes: this.env.resources.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        owner: r.owner || 'unowned',
        monthlyCost: r.monthlyCost || 0,
        entrypoint: Boolean(r.entrypoint),
        entrypointReason: r.entrypointReason || null,
        waste: this.waste.get(r.id) || 0,
      })),
      edges: this.env.edges,
    };
  }

  async close() {
    if (this.driver) await this.driver.close();
  }
}

module.exports = { ResourceGraph, QUERIES, CONSTRAINTS, BLAST_RADIUS_CYPHER: QUERIES.blastRadius };
