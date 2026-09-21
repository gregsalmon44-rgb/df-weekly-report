// Keep config/payer-rules.json up to date with the cards clients actually use.
//
// A client's vault id changes whenever they re-enter their card, and some hold
// several at once, so the sheet's "EasyPay Reference" column is always a little
// behind. This script finds every card that paid, works out who it belongs to
// (by the sheet's reference, or by the cardholder's name), and records any
// pairing that is not already known.
//
//   node scripts/learn-vaults.js            → show what it would add (no writes)
//   node scripts/learn-vaults.js --write    → add them to config/payer-rules.json
//
// Nothing is ever removed, and a card that cannot be attributed is left alone —
// it shows in the report's "Unallocated payments" section for a person to judge.
require('dotenv').config();
const ep = require('../src/easypay');
const payerRules = require('../src/payerRules');
const { fetchEntities } = require('../src/roster');
const { revenueByEntity } = require('../src/revenue');
const { config } = require('../src/config');
const { etDateStr } = require('../src/dates');

(async () => {
  const write = process.argv.includes('--write');
  const start = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || config.allTimeStart;
  const end = etDateStr();

  const { entities } = await fetchEntities({ force: true });
  const result = await revenueByEntity(start, end, entities, { force: true });
  if (!result.available) {
    console.error('Could not read EasyPay:', result.reason);
    process.exit(1);
  }

  const rules = payerRules.load();
  const known = new Set(rules.aliases.map(a => String(a.vault).toLowerCase()));
  const found = (result.stats.unknownVaults || []).filter(u => !known.has(u.vault.toLowerCase()));

  console.log(`Window ${start} → ${end}`);
  console.log(`Payments: ${result.stats.sales} sales, ${result.stats.viaReference} matched by reference, ` +
              `${result.stats.viaName} by name, ${result.stats.unmatched} unallocated.`);
  console.log(`Known card mappings: ${rules.aliases.length}. New ones found: ${found.length}.`);

  for (const f of found) console.log(`   ${f.client.padEnd(28)} vault ${f.vault}`);

  if (!found.length) return;
  if (!write) { console.log('\nRun again with --write to add these.'); return; }

  for (const f of found) {
    rules.aliases.push({ vault: f.vault, client: f.client, learned: etDateStr() });
  }
  const file = payerRules.save(rules);
  console.log(`\nAdded ${found.length} mapping(s) to ${file}`);
})().catch(e => { console.error(e); process.exit(1); });
