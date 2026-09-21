// Revenue that is DERIVED rather than collected.
//
// Most clients pay through EasyPay, so their revenue is whatever the gateway
// took. LeadBreakers (Cooper) is settled differently — leads are sold at an
// agreed rate, netted against his commission and a credits allowance — so no
// payment ever arrives that the gateway could report. Left alone, those rows
// show zero revenue against very real SMS and data costs, which is how
// LeadBreakers appeared to be losing $30,868 while trading perfectly well.
//
// The rules live in config/computed-revenue.json so a rate change is an edit,
// not a deploy.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'computed-revenue.json');

function loadRules() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (Array.isArray(raw.rules) ? raw.rules : []).map(r => ({
      ...r,
      re: new RegExp(r.campaignPattern, 'i'),
    }));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[ComputedRevenue] could not read the rules:', e.message);
    return [];
  }
}

// Which rule, if any, covers this entity? An entity qualifies when EVERY one of
// its campaigns matches — a half-match means the grouping is wrong and guessing
// would mix two billing arrangements in one row.
function ruleForEntity(rules, entity) {
  const names = (entity.campaigns || []).map(c => (typeof c === 'string' ? c : c.name) || '');
  if (!names.length) return null;
  for (const rule of rules) {
    const hits = names.filter(n => rule.re.test(n.trim()));
    if (hits.length === names.length) return rule;
    if (hits.length) return { ...rule, partial: true, matched: hits.length, total: names.length };
  }
  return null;
}

module.exports = { loadRules, ruleForEntity, FILE };
