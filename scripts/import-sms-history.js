// Load the sheet's "SMS Sent Out" history into the counter's table.
//
// The webhook only knows about messages sent after it was switched on, so
// without this the all-time figures would collapse the day the report starts
// reading from the counter. Runs day by day, keyed on the campaign's LocationID.
//
//   node scripts/import-sms-history.js                     → show what it would do
//   node scripts/import-sms-history.js --write             → write it
//   node scripts/import-sms-history.js 2026-07-01 2026-09-23 --write
//
// Idempotent: each day's figure is SET, not added, so running it twice leaves
// the same numbers. That also means it is safe to re-run after the sheet is
// corrected.
require('dotenv').config();
const { fetchTab, columnIndex } = require('../src/sheets');
const { sheetDateOnly, etDateStr } = require('../src/dates');
const { fetchCampaigns } = require('../src/roster');
const { parseCount } = require('../src/sms');
const { config } = require('../src/config');
const db = require('../src/db');

(async () => {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const start = dates[0] || config.allTimeStart;
  const end = dates[1] || etDateStr();

  if (!db.enabled()) {
    console.error('DATABASE_URL is not set — nowhere to import to.');
    process.exit(1);
  }

  const [rows, { campaigns }] = await Promise.all([
    fetchTab(config.tabSms, { force: true }),
    fetchCampaigns({ force: true }),
  ]);
  const head = rows[0] || [];
  const cDate = columnIndex(head, 'Date');
  const cCampaign = columnIndex(head, 'Campaign');
  const cCount = columnIndex(head, 'Number of SMS sent out', 'SMS Sent', 'Number of SMS');
  if (cDate === -1 || cCampaign === -1 || cCount === -1) {
    console.error('The SMS tab is missing its Date, Campaign or count column.');
    process.exit(1);
  }

  const locOf = new Map(campaigns.filter(c => c.locationId).map(c => [c.name.trim().toLowerCase(), c.locationId]));

  // Several sheet rows can cover the same campaign and day; they are summed
  // before writing, because the write SETS the day's figure.
  const byKey = new Map();
  const skipped = new Map();
  let read = 0, outOfRange = 0, unparseable = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const day = sheetDateOnly(r[cDate]);
    if (!day) { if (String(r[cDate] || '').trim()) unparseable++; continue; }
    if (day < start || day > end) { outOfRange++; continue; }
    const count = parseCount(r[cCount]);
    if (!count) continue;
    const name = String(r[cCampaign] || '').trim();
    const loc = locOf.get(name.toLowerCase());
    read += count;
    if (!loc) { skipped.set(name, (skipped.get(name) || 0) + count); continue; }
    const key = loc + '|' + day;
    const cur = byKey.get(key) || { locationId: loc, day, count: 0, campaign: name };
    cur.count += count;
    byKey.set(key, cur);
  }

  const toWrite = [...byKey.values()];
  const willWrite = toWrite.reduce((t, r) => t + r.count, 0);
  const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);

  console.log(`Window ${start} → ${end}`);
  console.log(`  sheet rows read:      ${read.toLocaleString('en-GB')} SMS`);
  console.log(`  ready to import:      ${willWrite.toLocaleString('en-GB')} SMS across ${toWrite.length} campaign-days`);
  console.log(`  no LocationID:        ${skippedTotal.toLocaleString('en-GB')} SMS across ${skipped.size} campaign(s)`);
  if (outOfRange) console.log(`  outside the window:   ${outOfRange} row(s)`);
  if (unparseable) console.log(`  unreadable dates:     ${unparseable} row(s)`);
  if (skipped.size) {
    console.log('\n  campaigns with no LocationID (their SMS cannot be imported):');
    [...skipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([n, c]) => console.log(`     ${String(c).padStart(8)}  ${n}`));
  }

  if (!write) { console.log('\nNothing written. Re-run with --write to import.'); process.exit(0); }

  await db.init();
  let done = 0;
  for (let i = 0; i < toWrite.length; i += 200) {
    const batch = toWrite.slice(i, i + 200);
    await db.setSmsSendsBatch(batch);
    done += batch.length;
    process.stdout.write(`\r  written: ${done}/${toWrite.length} campaign-days`);
  }
  const stored = await db.countSmsRows();
  console.log(`\nDone. The table now holds ${stored.total.toLocaleString('en-GB')} SMS across ${stored.n} rows.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
