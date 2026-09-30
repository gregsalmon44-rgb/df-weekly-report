// Lead counts, from the "SMS Leads" tab — one row per lead delivered.
//
// The join key is the GHL LocationID in column F. That column is being filled in
// across the history; until it is complete, a row without one is matched on its
// campaign name instead, and anything that matches neither is REPORTED rather
// than dropped. Silently skipping unkeyed rows is how a report quietly
// understates a client's leads while still charging them for the SMS.
const { fetchTab, columnIndex } = require('./sheets');
const { sheetDateOnly } = require('./dates');
const { config } = require('./config');

async function leadCounts(startDay, endDay, { force = false, campaignNames = null } = {}) {
  const rows = await fetchTab(config.tabLeads, { force });
  const out = {
    byLocation: new Map(), byCampaign: new Map(),
    // The same counts split by day. Needed because a derived rate can change
    // part-way through the reporting window — LeadBreakers moved from $48 to $55
    // a lead on 1 August — and a total alone cannot be valued once that is true.
    // Map<key, Map<'YYYY-MM-DD', count>>.
    byLocationDay: new Map(), byCampaignDay: new Map(),
    total: 0, viaLocation: 0, viaCampaign: 0,
    unmatched: 0, unmatchedSample: [], badDates: 0,
  };
  if (!rows.length) return out;

  const bump = (m, key, day) => {
    let d = m.get(key);
    if (!d) { d = new Map(); m.set(key, d); }
    d.set(day, (d.get(day) || 0) + 1);
  };

  const head = rows[0];
  const cDate = columnIndex(head, 'Date');
  const cCampaign = columnIndex(head, 'Campaign');
  const cLocation = columnIndex(head, 'LocationID', 'Location ID', 'Location Id');
  if (cDate === -1) throw new Error('Leads tab has no "Date" column.');

  const known = campaignNames
    ? new Set([...campaignNames].map(s => s.trim().toLowerCase()))
    : null;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const day = sheetDateOnly(r[cDate]);
    if (!day) { if ((r[cDate] || '').trim()) out.badDates++; continue; }
    if (day < startDay || day > endDay) continue;

    out.total++;
    const loc = cLocation === -1 ? '' : String(r[cLocation] || '').trim();
    const campaign = cCampaign === -1 ? '' : String(r[cCampaign] || '').trim();

    if (loc) {
      out.byLocation.set(loc, (out.byLocation.get(loc) || 0) + 1);
      bump(out.byLocationDay, loc, day);
      out.viaLocation++;
    } else if (campaign && (!known || known.has(campaign.toLowerCase()))) {
      const k = campaign.toLowerCase();
      out.byCampaign.set(k, (out.byCampaign.get(k) || 0) + 1);
      bump(out.byCampaignDay, k, day);
      out.viaCampaign++;
    } else {
      out.unmatched++;
      if (campaign && out.unmatchedSample.length < 8 && !out.unmatchedSample.includes(campaign)) {
        out.unmatchedSample.push(campaign);
      }
    }
  }
  return out;
}

module.exports = { leadCounts };
