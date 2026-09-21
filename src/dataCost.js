// Data cost per client, from the Demand Flow ZIP dashboard (PhantomDash).
//
// Keyed by GHL location id so the two systems agree on identity without matching
// names. The dashboard only knows a campaign's location id once its own client
// import reads the LocationID column from the master sheet — until then every
// dollar lands in `unallocated` and no client shows a data cost.
//
// A failure NEVER becomes a zero. Missing data cost overstates profit on every
// line, so the report prints a warning instead.
const { config } = require('./config');

const TIMEOUT_MS = 10000;

const unavailable = (reason) => ({
  available: false, reason,
  byLocation: new Map(),
  byCampaign: new Map(),
  totals: null,
});

// `keyedBy` picks which of the dashboard's two endpoints to read:
//   'campaign' — spend per campaign NAME. Works today.
//   'location' — spend per GHL location id. Better (a rename cannot break it),
//                but returns nothing until the LocationID column is filled in
//                and the dashboard has imported it.
async function fetchDataCost(startDay, endDay, keyedBy = 'campaign') {
  if (!config.phantomdashUrl || !config.phantomdashSecret) return unavailable('not configured');

  const path = keyedBy === 'location' ? 'cost-by-location' : 'cost-by-campaign';
  const url = `${config.phantomdashUrl}/api/${path}` +
              `?from=${encodeURIComponent(startDay)}&to=${encodeURIComponent(endDay)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'x-cost-api-secret': config.phantomdashSecret },
      signal: ctrl.signal,
    });
    if (res.status === 401) return unavailable('secret rejected');
    if (!res.ok) return unavailable(`HTTP ${res.status}`);
    const json = await res.json();

    const byKey = new Map();
    const source = json.byCampaign || json.byLocation || {};
    for (const [key, cents] of Object.entries(source)) {
      byKey.set(keyedBy === 'campaign' ? key.toLowerCase() : key, Math.round(Number(cents) || 0) / 100); // cents → dollars
    }
    const t = json.totals || {};
    return {
      available: true, reason: null, keyedBy,
      byLocation: keyedBy === 'location' ? byKey : new Map(),
      byCampaign: keyedBy === 'campaign' ? byKey : new Map(),
      totals: {
        allocated: Math.round(t.allocatedCents || 0) / 100,
        notAClient: Math.round(t.notAClientCents || 0) / 100,
        unallocated: Math.round(t.unallocatedCents || 0) / 100,
        total: Math.round(t.totalCents || 0) / 100,
      },
    };
  } catch (e) {
    return unavailable(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchDataCost };
