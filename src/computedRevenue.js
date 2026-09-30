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

// What a lead delivered on `day` is worth. Bands are [{ from, perLead }] with
// `from` inclusive; the last band starting on or before the day wins. A rule
// with no bands keeps its single perLead, so old rules still work.
//
// A day BEFORE the first band is possible if the window is ever backdated, so
// it falls back to the rule's own perLead rather than valuing those leads at
// nothing — a silent zero would read as a bad month rather than a missing band.
function rateForDay(rule, day) {
  const bands = Array.isArray(rule.bands) ? rule.bands : null;
  const base = Number(rule.perLead) || 0;
  if (!bands || !bands.length || !day) return base;
  let rate = null;
  for (const b of [...bands].sort((a, z) => String(a.from).localeCompare(String(z.from)))) {
    if (String(day) >= String(b.from)) rate = Number(b.perLead);
  }
  return rate === null ? base : rate;
}

// Value leads that are split by day. Returns the money plus the per-rate split,
// so the arithmetic can be shown rather than asserted.
function revenueForDays(rule, byDay) {
  const out = { revenue: 0, leads: 0, bands: [] };
  if (!byDay) return out;
  const acc = new Map();
  for (const [day, n] of byDay) {
    const rate = rateForDay(rule, day);
    out.revenue += n * rate;
    out.leads += n;
    const cur = acc.get(rate) || { rate, leads: 0, revenue: 0 };
    cur.leads += n; cur.revenue += n * rate;
    acc.set(rate, cur);
  }
  out.revenue = Math.round(out.revenue * 100) / 100;
  out.bands = [...acc.values()].sort((a, b) => a.rate - b.rate);
  return out;
}

// How a rule's rate reads in a warning.
function rateLabel(rule) {
  const bands = Array.isArray(rule.bands) ? rule.bands : null;
  if (!bands || !bands.length) return `$${rule.perLead}/lead`;
  return bands.map(b => `$${b.perLead}/lead from ${b.from}`).join(', ');
}

module.exports = { loadRules, ruleForEntity, rateForDay, revenueForDays, rateLabel, FILE };
