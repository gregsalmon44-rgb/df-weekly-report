// The profit & loss itself: leads, SMS, cost and revenue per billing entity,
// grouped by industry.
//
// Net profit = revenue − SMS cost − data cost. Nothing else is deducted (no
// phone numbers, no registration fees, no payroll), which is what the report's
// own footnote says.
const { config } = require('./config');
const { fetchEntities } = require('./roster');
const { leadCounts } = require('./leads');
const { smsCounts } = require('./sms');
const { fetchDataCost, fetchDataCostBoth } = require('./dataCost');
const { revenueByEntity } = require('./revenue');
const { etDateStr, lastFullWeek } = require('./dates');
const db = require('./db');
const computed = require('./computedRevenue');
const { checkSheet } = require('./sheetHealth');

const MULTI_INDUSTRY = 'Multiple industries';
const round2 = v => Math.round(v * 100) / 100;
const ZERO = { leads: 0, sms: 0, deposits: 0, cost: 0, dataCost: 0, netProfit: 0 };
const addStats = (a, b) => ({
  leads: a.leads + b.leads, sms: a.sms + b.sms, deposits: round2(a.deposits + b.deposits),
  cost: round2(a.cost + b.cost), dataCost: round2(a.dataCost + b.dataCost),
  netProfit: round2(a.netProfit + b.netProfit),
});

// Revenue comes straight from EasyPay, keyed by BILLING ENTITY (see revenue.js).
// It stays behind an availability flag: a gateway that cannot be reached must
// read as "unavailable", never as $0 revenue against real costs, which would
// show every client as a loss and look plausible.

// industryOverride pins a client to the category the ALL-TIME run put them in,
// so the same client cannot appear under one category all-time and another for
// last week purely because of what they happened to deliver in those seven days.
async function getPnl(startDay, endDay, { force = false, industryOverride = null } = {}) {
  const override = industryOverride || new Map();
  const { entities, campaigns, warnings } = await fetchEntities({ force });
  const computedRules = computed.loadRules();
  const computedUsed = new Set();
  const campaignNames = new Set(campaigns.map(c => c.name));

  const [leads, sms, data, revenue, sheetProblems] = await Promise.all([
    leadCounts(startDay, endDay, { force, campaignNames }),
    smsCounts(startDay, endDay, { force }),
    config.dataCostKey === 'both'
      ? fetchDataCostBoth(startDay, endDay)
      : fetchDataCost(startDay, endDay, config.dataCostKey),
    revenueByEntity(startDay, endDay, entities, { force }),
    checkSheet({ force }),
  ]);
  // A renamed column does not break the report, it quietly removes an input —
  // so say so on the page rather than letting the figures drift.
  for (const p of sheetProblems) warnings.unshift(`SHEET: ${p.message}`);

  // Leads and SMS belong to a CAMPAIGN, so they can be split by industry even
  // though revenue cannot — a client pays one combined amount. That split is
  // what shows whether their roofing campaigns run better than their solar ones.
  const campaignVolume = (c) => {
    const loc = (c.locationId || '').trim();
    const name = c.name.toLowerCase();
    const cLeads = (loc ? leads.byLocation.get(loc) || 0 : 0) + (leads.byCampaign.get(name) || 0);
    const cSms = sms.source === 'webhook'
      ? (loc ? sms.byLocation.get(loc) || 0 : (sms.byCampaign.get(name) || 0))
      : (sms.byCampaign.get(name) || 0);
    return { leads: cLeads, sms: cSms };
  };

  const rows = [];
  for (const e of entities) {
    let nLeads = 0, nSms = 0, dataCost = 0;
    // Revenue is attributed per billing entity, not per campaign location.
    let dep = revenue.byEntity.get(e.key) || 0;

    for (const loc of e.locationIds) {
      nLeads += leads.byLocation.get(loc) || 0;
      dataCost += data.byLocation.get(loc) || 0;
      if (sms.source === 'webhook') nSms += sms.byLocation.get(loc) || 0;
    }
    for (const c of e.campaigns) {
      const key = c.name.toLowerCase();
      // Leads whose row carries no location id yet are matched on campaign name.
      nLeads += leads.byCampaign.get(key) || 0;
      // Name-keyed data cost is a FALLBACK: a campaign with a location id is
      // already counted above, and adding it again would double its cost.
      if (!(c.locationId || '').trim()) dataCost += data.byCampaign.get(key) || 0;
      // Sheet figures are a FALLBACK once the counter is the source: used only
      // where a campaign has no location id for the counter to report against.
      if (sms.source !== 'webhook' || !(c.locationId || '').trim()) {
        nSms += sms.byCampaign.get(key) || 0;
      }
    }

    const cost = round2(nSms * config.smsUnitCost);
    dataCost = round2(dataCost);
    dep = round2(dep);

    // Clients settled outside the gateway: value their leads at the agreed rate
    // instead. Any gateway payments for them are reported rather than dropped.
    const rule = computed.ruleForEntity(computedRules, e);
    let computedNote = null;
    if (rule && !rule.partial) {
      if (dep) {
        warnings.push(`${e.name} has ${'$' + dep} of gateway payments, but their revenue is calculated at ` +
          `$${rule.perLead}/lead — the gateway figure is not counted.`);
      }
      dep = round2(nLeads * rule.perLead);
      computedNote = rule;
      computedUsed.add(rule.id);
    } else if (rule && rule.partial) {
      warnings.push(`${e.name}: only ${rule.matched} of ${rule.total} campaigns match the "${rule.id}" revenue rule, ` +
        `so the rule was NOT applied — check the campaign names.`);
    }

    // A client whose campaigns span several industries gets its own category,
    // rather than being dropped whole into whichever industry happened to come
    // first in the sheet — Stellar Pro alone spans four, and would otherwise
    // swing one industry's totals by itself.
    const ownIndustries = [...new Set(e.campaigns.map(c => (c.industry || '').trim()).filter(Boolean))];

    // Only industries that have actually DELIVERED count towards "multiple".
    // A client whose second campaign has not produced a lead yet belongs in the
    // industry that did the work — they move once the other campaign delivers.
    const volumeByIndustry = ownIndustries.map(ind => {
      const v = e.campaigns
        .filter(c => (c.industry || '').trim() === ind)
        .reduce((t, c) => { const x = campaignVolume(c); return { leads: t.leads + x.leads, sms: t.sms + x.sms }; }, { leads: 0, sms: 0 });
      return { industry: ind, leads: v.leads, sms: v.sms };
    });
    // A rule may ask to be broken down by STATE instead of industry — Cooper
    // runs one campaign per state, so "which states work" is the useful split,
    // and all of his campaigns share a single industry anyway. The full state
    // name in the campaign title reads better than the sheet's two-letter code.
    const stateOf = (c) => {
      const m = /\(([^)]+)\)\s*$/.exec(c.name || '');
      return (m && m[1].trim()) || (c.state || '').trim() || 'Unknown';
    };
    const volumeByState = () => {
      const by = new Map();
      for (const c of e.campaigns) {
        const label = stateOf(c);
        const v = campaignVolume(c);
        const cur = by.get(label) || { label, leads: 0, sms: 0 };
        cur.leads += v.leads; cur.sms += v.sms;
        by.set(label, cur);
      }
      return [...by.values()].filter(b => b.leads || b.sms).sort((a, b) => b.leads - a.leads);
    };

    const delivering = volumeByIndustry.filter(b => b.leads > 0);
    // Nothing delivered anywhere: leave the client where they were rather than
    // picking an industry on no evidence.
    const active = delivering.length ? delivering : volumeByIndustry.filter(b => b.sms > 0);

    const industry = computedNote ? computedNote.industry
      : override.get(e.key) ? override.get(e.key)
      : active.length === 1 ? active[0].industry
      : ownIndustries.length > 1 ? MULTI_INDUSTRY
      : (ownIndustries[0] || 'Other');

    const row = {
      name: computedNote ? computedNote.client : e.name,
      computed: computedNote ? { perLead: computedNote.perLead, id: computedNote.id } : null,
      key: e.key, off: e.off,
      industry,
      industries: ownIndustries,
      // Per-industry volume, for clients that span more than one. Volume only:
      // revenue arrives as a single payment and cannot honestly be split.
      // Carried whenever the client spans industries, whatever THIS window shows:
      // the report pairs last week's figures to the all-time sub-lines, and a
      // quiet week would otherwise blank them out entirely.
      industryBreakdown: computedNote && computedNote.breakdownBy === 'state'
        ? volumeByState()
        : ownIndustries.length > 1
          ? volumeByIndustry.filter(b => b.leads || b.sms).sort((a, b) => b.leads - a.leads)
          : null,
      leads: nLeads, sms: nSms, deposits: dep, cost, dataCost,
      netProfit: round2(dep - cost - dataCost),
      locationIds: e.locationIds, campaigns: e.campaigns.map(c => c.name),
    };
    // A client with no activity at all in the window is not worth a line; one
    // with data spend and nothing else IS (that spend is a real loss).
    if (row.leads || row.sms || row.deposits || row.dataCost) rows.push(row);
  }

  // Clients who have paid but are not in the master sheet yet (config/payer-rules.json).
  // They get a row so their money is counted, flagged so nobody forgets to add them.
  for (const p of (revenue.pending || [])) {
    const key = 'pending:' + p.name.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    const dep = round2(revenue.byEntity.get(key) || 0);
    if (!dep) continue;
    rows.push({
      name: `${p.name} (not in the sheet yet)`, key, off: false, industry: p.industry || 'Other',
      leads: 0, sms: 0, deposits: dep, cost: 0, dataCost: 0, netProfit: dep,
      locationIds: [], campaigns: [], pending: true,
    });
  }

  const byIndustry = new Map();
  for (const r of rows) {
    if (!byIndustry.has(r.industry)) byIndustry.set(r.industry, []);
    byIndustry.get(r.industry).push(r);
  }
  const industries = [...byIndustry.entries()].map(([industry, clients]) => {
    clients.sort((a, b) => b.netProfit - a.netProfit);
    return { industry, clients, totals: clients.reduce(addStats, { ...ZERO }) };
  }).sort((a, b) => b.totals.netProfit - a.totals.netProfit);

  const grand = rows.reduce(addStats, { ...ZERO });

  // Does this look like a complete read of the sheet?
  const SANE_SMS_PER_LEAD = 10000;
  const ratio = grand.leads > 0 ? grand.sms / grand.leads : Infinity;
  const suspect = grand.sms > 50000 && ratio > SANE_SMS_PER_LEAD
    ? `Only ${grand.leads} lead(s) were read against ${Math.round(grand.sms).toLocaleString('en-GB')} SMS ` +
      `(${isFinite(ratio) ? Math.round(ratio).toLocaleString('en-GB') : '∞'} per lead). The leads tab is almost certainly ` +
      `being read through an active FILTER, which hides rows from the export — clear the filter on the "${config.tabLeads}" tab.`
    : null;
  if (suspect) warnings.unshift('SHEET: ' + suspect);

  return {
    rangeStart: startDay, rangeEnd: endDay,
    clientCount: rows.length,
    grand, industries,
    dataSpend: { available: data.available, reason: data.reason, totals: data.totals, keyedBy: data.keyedBy || null },
    smsSource: { source: sms.source, available: sms.available !== false, reason: sms.reason || null, total: sms.total },
    revenueSource: { available: revenue.available, reason: revenue.reason, stats: revenue.stats || null },
    attribution: {
      leadsTotal: leads.total, leadsViaLocation: leads.viaLocation, leadsViaCampaign: leads.viaCampaign,
      leadsUnmatched: leads.unmatched, leadsUnmatchedSample: leads.unmatchedSample, leadsBadDates: leads.badDates,
    },
    suspect,
    computedRules: computedRules.filter(r => computedUsed.has(r.id)).map(r => ({ id: r.id, client: r.client, industry: r.industry, perLead: r.perLead, footnote: r.footnote, footnoteLead: r.footnoteLead })),
    warnings,
  };
}

// The full report payload: all-time alongside the week just finished.
async function buildReportData(start, end, opts = {}) {
  const week = (start && end) ? { start, end } : lastFullWeek();
  // All-time first: its industry classification is then applied to the week, so
  // both halves of every row describe the same client in the same category.
  const allTime = await getPnl(config.allTimeStart, etDateStr(), opts);
  const industryOverride = new Map();
  for (const ind of allTime.industries) for (const c of ind.clients) industryOverride.set(c.key, c.industry);
  const lastWeek = await getPnl(week.start, week.end, { ...opts, industryOverride });
  return { generatedFor: etDateStr(), allTime, lastWeek, smsUnitCost: config.smsUnitCost };
}

module.exports = { getPnl, buildReportData, addStats, ZERO };
