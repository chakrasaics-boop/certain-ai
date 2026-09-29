// Load data/acme-env.json into Neo4j (AuraDB Free works) and run the queries CertAIn uses.
// Usage: NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io NEO4J_USER=neo4j NEO4J_PASSWORD=... npm run seed:neo4j
const { ResourceGraph, CONSTRAINTS } = require('../src/graph');
const env = require('../data/acme-env.json');

(async () => {
  if (!process.env.NEO4J_URI) {
    console.error('Set NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD (AuraDB: console.neo4j.io -> New instance -> Free).');
    process.exit(1);
  }
  const g = await new ResourceGraph(env).init(); // creates constraints, clears old CertAIn nodes, loads
  if (g.engine !== 'neo4j') {
    console.error(g.status);
    process.exit(1);
  }
  console.log(`Loaded into ${process.env.NEO4J_URI}`);
  console.log(`  constraints: ${CONSTRAINTS.length}`);
  const c = await g.run('MATCH (r:WPResource) WITH count(r) AS r MATCH (:WPResource)-[d:DEPENDS_ON]->() WITH r, count(d) AS d MATCH (e:Entrypoint) WITH r, d, count(e) AS e MATCH (t:Team) RETURN r, d, e, count(t) AS t');
  const row = c.records[0];
  console.log(`  ${row.get('r')} :WPResource, ${row.get('d')} :DEPENDS_ON, ${row.get('e')} :Entrypoint, ${row.get('t')} :Team`);

  const o = await g.orphans();
  console.log(`\nOrphan detection (${o.engine}): ${o.orphans.map((x) => x.name).join(', ')}`);
  const b = await g.blastRadius('rds-legacy-billing');
  console.log(`Blast radius of rds-legacy-billing (${b.engine}): ${b.directCount} direct, ${b.totalCount} total -> ${b.dependents.map((d) => `${d.name}@${d.hops}`).join(', ')}`);
  const t = await g.teamRollup();
  console.log(`Team rollup (${t.engine}): ${t.rows.map((r) => `${r.team} $${Math.round(r.spend)}`).join(', ')}`);
  console.log('\nTry in Neo4j Browser:\n  MATCH p=(:Entrypoint)-[:DEPENDS_ON*1..8]->(:WPResource) RETURN p');
  await g.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
