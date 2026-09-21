// The client roster, read from the master tab ("SMS Schedule View").
//
// One sheet row = one CAMPAIGN. A client usually runs several ("Dakota Andekin 1",
// "Dakota Andekin 2"), and Demand Flow bills them as one, so the report groups
// campaigns into a BILLING ENTITY and reports per entity. Without that grouping,
// one campaign shows as pure revenue and its sibling as pure cost.
const { fetchTab, columnIndex } = require('./sheets');
const { config } = require('./config');

// Campaign name → the client behind it. The naming convention is
// "<person> <number> - <company>" or "<person> <number> (<trade>)", so the
// company/trade suffix and the campaign number are stripped.
//
// Deliberately conservative: it only ever merges campaigns that share a person's
// name, and a name that doesn't fit the convention is left as its own entity
// rather than being guessed at.

// The key two campaigns are compared on. Punctuation and spacing are stripped
// out, because the same client is written several ways in the sheet:
// "Stellar Pro - NC - Painting" and "Stellar-Pro (Ohio)" are one client, and
// keying on the raw name split them into two — one holding the leads and costs,
// the other holding all the revenue.
function entityKeyFor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[-–—_.]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function entityKeyOf(campaignName) {
  let s = String(campaignName || '').trim();
  // Drop " - Company Name". The dash needs a space on only ONE side, because the
  // sheet contains both "Victor Vasquez- Sunrun" and "Omar Ramirez -Sun Capital";
  // requiring both left those companies inside the client's name, so their
  // payments never matched. A dash with no spaces at all is left alone, so a
  // hyphenated surname survives.
  s = s.split(/\s+[-–—]\s*|\s*[-–—]\s+/)[0];
  s = s.replace(/\s*\([^)]*\)\s*$/, ''); // drop " (Trade)"
  s = s.replace(/\s+\d+\s*$/, '');       // drop the trailing campaign number
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Statuses seen in the sheet: ACTIVE, PAUSE, OFF, RENEW, READY, NEED ZIPS,
// PAYMENT, PENDING, LOW CONTACTS, SET UP. Only OFF means "no longer a client";
// everything else is a live client in some state of play.
const OFF_STATUS = 'OFF';

async function fetchCampaigns({ force = false } = {}) {
  const rows = await fetchTab(config.tabRoster, { force });
  if (!rows.length) return { campaigns: [], warnings: ['Roster tab is empty.'] };

  const head = rows[0];
  const cName = columnIndex(head, 'Campaign');
  const cIndustry = columnIndex(head, 'Industry');
  const cStatus = columnIndex(head, 'Status');
  const cLocation = columnIndex(head, 'LocationID', 'Location ID', 'Location Id');
  const cPerLead = columnIndex(head, '$/Lead', '$ / Lead', 'Price Per Lead');
  const cState = columnIndex(head, 'State');

  const warnings = [];
  if (cName === -1) throw new Error('Roster tab has no "Campaign" column — check the header row.');
  if (cLocation === -1) warnings.push('Roster tab has no "LocationID" column — no campaign can be matched to its leads.');
  if (cIndustry === -1) warnings.push('Roster tab has no "Industry" column — every client will group under "Other".');

  const campaigns = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[cName] || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) { warnings.push(`Duplicate campaign row ignored: "${name}".`); continue; }
    seen.add(key);

    // Section dividers typed into the campaign column ("Off Boarded",
    // "Seasonal/ Long term Pause") are not clients. They carry no status, no
    // industry and no location id, which is what distinguishes them from a real
    // row — otherwise they become phantom clients the moment anything matches
    // their name.
    const isDivider = !String(r[cStatus] || '').trim() &&
                      (cIndustry === -1 || !String(r[cIndustry] || '').trim()) &&
                      (cLocation === -1 || !String(r[cLocation] || '').trim());
    if (isDivider) continue;

    campaigns.push({
      name,
      industry: cIndustry === -1 ? '' : String(r[cIndustry] || '').trim(),
      status: cStatus === -1 ? '' : String(r[cStatus] || '').trim().toUpperCase(),
      locationId: cLocation === -1 ? '' : String(r[cLocation] || '').trim(),
      pricePerLead: cPerLead === -1 ? '' : String(r[cPerLead] || '').trim(),
      state: cState === -1 ? '' : String(r[cState] || '').trim(),
    });
  }
  return { campaigns, warnings };
}

// Campaigns → billing entities.
async function fetchEntities(opts) {
  const { campaigns, warnings } = await fetchCampaigns(opts);
  const byKey = new Map();

  for (const c of campaigns) {
    const key = entityKeyFor(entityKeyOf(c.name)) || entityKeyFor(c.name);
    let e = byKey.get(key);
    if (!e) {
      e = { key, name: entityKeyOf(c.name) || c.name, campaigns: [], locationIds: [], industry: '', off: true };
      byKey.set(key, e);
    }
    e.campaigns.push(c);
    if (c.locationId && !e.locationIds.includes(c.locationId)) e.locationIds.push(c.locationId);
    // First non-empty industry wins — siblings occasionally differ ("New Fence"
    // vs "Mold") and the entity has to sit somewhere.
    if (!e.industry && c.industry) e.industry = c.industry;
    // OFF only when EVERY campaign is off.
    if (c.status !== OFF_STATUS) e.off = false;
  }

  const entities = [...byKey.values()];
  const noLocation = entities.filter(e => !e.locationIds.length && !e.off);
  if (noLocation.length) {
    warnings.push(`${noLocation.length} live client(s) have no LocationID on any campaign, so they have no leads or data cost: ` +
      noLocation.slice(0, 8).map(e => e.name).join(', ') + (noLocation.length > 8 ? ', …' : ''));
  }
  return { entities, campaigns, warnings };
}

module.exports = { fetchCampaigns, fetchEntities, entityKeyOf, entityKeyFor, OFF_STATUS };
