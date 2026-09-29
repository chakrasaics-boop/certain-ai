// Copies the AuraDB credentials file (Neo4j-xxxx-Created-....txt) into .env.
// Usage: npm run neo4j:env            (finds the newest file in your Downloads folder)
//        npm run neo4j:env -- <path>  (or point it at the file)
const fs = require('fs');
const path = require('path');
const os = require('os');

function findCredsFile() {
  const dirs = [path.join(os.homedir(), 'Downloads')];
  try {
    for (const u of fs.readdirSync('/mnt/c/Users')) dirs.push(path.join('/mnt/c/Users', u, 'Downloads'));
  } catch {}
  const files = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (/^neo4j.*\.txt$/i.test(f)) {
          const p = path.join(d, f);
          files.push({ p, t: fs.statSync(p).mtimeMs });
        }
      }
    } catch {}
  }
  files.sort((a, b) => b.t - a.t);
  return files[0] && files[0].p;
}

const file = process.argv[2] || findCredsFile();
if (!file) {
  console.error('Could not find a Neo4j-*.txt file in Downloads. Run: npm run neo4j:env -- /path/to/file.txt');
  process.exit(1);
}
const vals = {};
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*(NEO4J_[A-Z]+)\s*=\s*(.+?)\s*$/);
  if (m) vals[m[1]] = m[2];
}
const uri = vals.NEO4J_URI;
const user = vals.NEO4J_USERNAME || vals.NEO4J_USER || 'neo4j';
const pass = vals.NEO4J_PASSWORD;
if (!uri || !pass) {
  console.error(`${file} does not contain NEO4J_URI and NEO4J_PASSWORD`);
  process.exit(1);
}
const envPath = path.join(__dirname, '..', '.env');
const kept = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/).filter((l) => !/^\s*NEO4J_(URI|USER|USERNAME|PASSWORD)\s*=/.test(l))
  : [];
while (kept.length && kept[kept.length - 1] === '') kept.pop();
kept.push(`NEO4J_URI=${uri}`, `NEO4J_USER=${user}`, `NEO4J_PASSWORD=${pass}`, '');
fs.writeFileSync(envPath, kept.join('\n'));
console.log(`Read ${file}`);
console.log(`Wrote NEO4J_URI=${uri}, NEO4J_USER=${user}, NEO4J_PASSWORD=**** to .env`);
console.log('Next: npm run seed:neo4j && npm start');
