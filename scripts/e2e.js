// End-to-end UI test + screenshots. Usage: BASE_URL=http://localhost:3000 node scripts/e2e.js
// Needs Playwright (global install is fine): NODE_PATH=$(npm root -g) node scripts/e2e.js
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'screenshots');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', async (d) => {
    errors.push('dialog: ' + d.message());
    await d.dismiss();
  });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('saved', name);
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#integrations .integ');
  await page.waitForTimeout(800);
  await shot('01-landing.png');

  await page.click('#auditBtn');
  await page.waitForSelector('.fcard[data-id="f2"]', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shot('02-audit-streaming.png');

  await page.waitForFunction(() => !document.querySelector('#auditBtn').disabled, null, { timeout: 120000 });
  await page.click('.fcard[data-id="f1"]');
  await page.waitForTimeout(900);
  await shot('03-gpu-finding-blast-radius.png');

  await page.click('[data-act="dryrun"]');
  await page.waitForSelector('[data-act="approve"]', { timeout: 30000 });
  await page.waitForTimeout(1400);
  await shot('04-gpu-dry-run-passed.png');

  await page.click('[data-act="approve"]');
  await page.waitForSelector('[data-act="rollback"]', { timeout: 60000 });
  await page.waitForTimeout(1200);
  const saved = await page.textContent('#savedMoney');
  const co2 = await page.textContent('#savedCo2');
  const cost = await page.textContent('#auditCost');
  console.log('counters:', saved, co2 + ' kg', cost);
  await shot('05-gpu-executed-counters.png');

  // Proof receipt for the executed GPU fix, downloaded as JSON.
  await page.waitForSelector('.receipt.executed .rc-id', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('.receipt').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await shot('05b-gpu-proof-receipt.png');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.receipt a[download]')]);
  const receipt = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  console.log('receipt:', receipt.receiptId, receipt.outcome, receipt.duplocloud.command, receipt.impact.usdPerMonth, receipt.impact.kgCo2PerMonth);
  if (receipt.outcome !== 'executed' || receipt.blastRadius.directDependents !== 0 || !receipt.approval || !receipt.dryRun?.passed) throw new Error('bad GPU receipt');

  await page.click('.fcard[data-id="f2"]');
  await page.waitForTimeout(900);
  const hasApprove = await page.$('#detail [data-act="approve"], #detail [data-act="dryrun"]');
  console.log('vetoed DB shows approve/dry-run button:', Boolean(hasApprove));
  await shot('06-db-vetoed.png');
  await page.waitForSelector('.receipt.vetoed .rc-id', { timeout: 15000 });
  const vetoReceipt = await page.evaluate(() => fetch('/api/findings/f2/receipt').then((r) => r.json()));
  console.log('veto receipt:', vetoReceipt.receiptId, vetoReceipt.outcome, vetoReceipt.blastRadius.directDependents, vetoReceipt.criticVerdict.verdict);
  if (vetoReceipt.outcome !== 'vetoed' || vetoReceipt.blastRadius.directDependents !== 3) throw new Error('bad veto receipt');
  await page.evaluate(() => document.querySelector('.receipt').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await shot('06b-db-veto-receipt.png');

  // Human approval through the Band room instead of the UI button.
  await page.click('.fcard[data-id="f7"]');
  await page.waitForTimeout(500);
  await page.click('[data-act="dryrun"]');
  await page.waitForSelector('[data-act="band-approve"]', { timeout: 30000 });
  await page.click('[data-act="band-approve"]');
  await page.waitForSelector('.fcard[data-id="f7"] .badge.executed', { timeout: 60000 });
  const roomApproval = await page.evaluate(() => [...document.querySelectorAll('#room .msg.human .bubble')].some((b) => /approve f7/.test(b.textContent)));
  console.log('band-room approval executed f7:', roomApproval, '| saved now', await page.textContent('#savedMoney'));
  if (!roomApproval) throw new Error('room approval message missing');
  await page.waitForTimeout(800);
  await shot('06c-band-room-approval.png');

  const mult = (await page.isVisible('#costMult')) ? await page.textContent('#multText') : '';
  console.log('cost multiplier:', mult);
  if (!/cheaper than/.test(mult)) throw new Error('multiplier missing');

  // Graph-found finding (orphan chain) + Graph tab.
  await page.click('.fcard[data-id="f3"]');
  await page.waitForTimeout(800);
  const f3 = await page.textContent('.fcard[data-id="f3"]');
  console.log('f3:', f3.includes('Found by graph') ? 'Found by graph' : 'MISSING graph chip', '|', await page.textContent('#detail h3'));
  if (!f3.includes('Found by graph')) throw new Error('graph-found finding missing');
  await shot('03b-found-by-graph.png');
  await page.click('.tab[data-tab="graph"]');
  await page.waitForSelector('#queries .q', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const teams = await page.$$eval('.team-row', (els) => els.length);
  console.log('graph tab: queries', await page.$$eval('#queries .q', (e) => e.length), 'teams', teams);
  await shot('10-graph-tab.png');
  await page.click('.tab[data-tab="audit"]');

  await page.click('.fcard[data-id="f4"]');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.quote')?.scrollIntoView());
  await shot('07-llm-reroute-openrouter.png');

  // Try it on your bill: sample CUR -> findings -> Prove & fix routes into the proof flow.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#billBtn');
  await page.click('#sampleBtn');
  await page.waitForSelector('.bcard', { timeout: 30000 });
  await page.waitForTimeout(500);
  const billSummary = await page.$$eval('.bill-sum .v', (els) => els.map((e) => e.textContent.trim()));
  const billCards = await page.$$eval('.bcard .t', (els) => els.map((e) => e.textContent));
  console.log('bill:', billSummary.join(' | '), '| top:', billCards.join(', '));
  if (billCards.length !== 5 || !billCards.includes('Idle GPU instance')) throw new Error('bill analysis missing findings');
  await shot('09-bill-analysis.png');
  const gpuCard = await page.$('.bcard:has(.t:text-is("Idle GPU instance")) [data-prove]');
  await gpuCard.click();
  await page.waitForFunction(() => document.querySelector('#billModal').hidden && /gpu-finetune-01/.test(document.querySelector('#detail .res')?.textContent || ''), null, { timeout: 30000 });
  console.log('prove & fix opened:', await page.textContent('#detail h3'));

  // Demo helper: ?focus=veto selects the vetoed database as soon as it is found.
  const vp = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await vp.goto(BASE + '/?focus=veto', { waitUntil: 'domcontentloaded' });
  await vp.waitForSelector('#integrations .integ');
  await vp.click('#auditBtn');
  await vp.waitForSelector('.fcard.refused.active', { timeout: 60000 });
  await vp.waitForFunction(() => !document.querySelector('#auditBtn').disabled, null, { timeout: 120000 });
  await vp.waitForTimeout(800);
  console.log('focus=veto selected:', await vp.textContent('.fcard.active .title'));
  await vp.screenshot({ path: path.join(OUT, '00-veto-first.png') });
  await vp.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(BASE, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(500);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('mobile horizontal overflow:', overflow);
  await mobile.screenshot({ path: path.join(OUT, '08-mobile.png'), fullPage: false });

  const real = errors.filter((e) => !/ERR_CERT|fonts\.g/.test(e));
  console.log('page errors:', real.length ? real : 'none', errors.length - real.length ? `(ignored ${errors.length - real.length} font/cert errors)` : '');
  await browser.close();
  if (real.length || hasApprove || !saved.includes('3,104')) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
