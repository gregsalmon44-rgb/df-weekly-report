// SMS sent, per campaign per day.
//
// TWO SOURCES, in order of preference:
//   1. the `sms_sends` table, written by the GHL webhook (src/smsCounter.js) —
//      automatic, and what the daily EOD report will eventually run on;
//   2. the sheet's "SMS Sent Out" tab, which the team fills in by hand today.
//
// The sheet is the fallback so the report works before the webhook exists, and
// stays the historical record for days the webhook was not yet running. Which
// source answered is reported, never assumed: an empty SMS table and a genuinely
// quiet week look identical in the numbers alone.
const { fetchTab, columnIndex } = require('./sheets');
const { sheetDateOnly } = require('./dates');
const { config } = require('./config');
const db = require('./db');

// "5,000" and " 800 " are both in the tab today.
function parseCount(v) {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
  return isFinite(n) && n > 0 ? Math.round(n) : 0;
}

async function smsFromSheet(startDay, endDay, { force = false } = {}) {
  const rows = await fetchTab(config.tabSms, { force });
  const out = { source: 'sheet', available: true, byCampaign: new Map(), byLocation: new Map(), total: 0, badDates: 0 };
  if (!rows.length) return out;

  const head = rows[0];
  const cDate = columnIndex(head, 'Date');
  const cCampaign = columnIndex(head, 'Campaign');
  const cCount = columnIndex(head, 'Number of SMS sent out', 'SMS Sent', 'Number of SMS');
  if (cDate === -1 || cCampaign === -1 || cCount === -1) {
    return { ...out, available: false, reason: 'the "SMS Sent Out" tab is missing its Date, Campaign or count column' };
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const day = sheetDateOnly(r[cDate]);
    if (!day) { if ((r[cDate] || '').trim()) out.badDates++; continue; }
    if (day < startDay || day > endDay) continue;
    const count = parseCount(r[cCount]);
    if (!count) continue;
    const key = String(r[cCampaign] || '').trim().toLowerCase();
    if (!key) continue;
    out.byCampaign.set(key, (out.byCampaign.get(key) || 0) + count);
    out.total += count;
  }
  return out;
}

async function smsFromDb(startDay, endDay) {
  const rows = await db.getSmsSendsForRange(startDay, endDay);
  const out = { source: 'webhook', available: true, byCampaign: new Map(), byLocation: new Map(), total: 0, badDates: 0 };
  for (const r of rows) {
    const loc = String(r.location_id || '').trim();
    const count = Number(r.count) || 0;
    if (!loc || !count) continue;
    out.byLocation.set(loc, (out.byLocation.get(loc) || 0) + count);
    out.total += count;
  }
  return out;
}

// Prefers the webhook table once it actually holds data for the window asked
// for; otherwise falls back to the sheet. A half-migrated week (webhook started
// mid-week) would otherwise report only the days the webhook saw.
async function smsCounts(startDay, endDay, opts = {}) {
  const source = config.smsSource;

  if (source !== 'sheet' && db.enabled()) {
    try {
      const fromDb = await smsFromDb(startDay, endDay);
      if (source === 'webhook' || fromDb.total > 0) {
        // A campaign with no LocationID can never appear in the counter — the
        // webhook reports by location id and these campaigns are OFF anyway, so
        // nothing will ever send from them again. Their history exists only on
        // the sheet (270k messages), so the sheet's figures are carried
        // alongside; the caller uses them ONLY for campaigns that have no id,
        // which is why nothing is counted twice.
        const sheet = await smsFromSheet(startDay, endDay, opts).catch(() => null);
        return { ...fromDb, byCampaign: sheet ? sheet.byCampaign : new Map(),
                 sheetTotal: sheet ? sheet.total : 0 };
      }
    } catch (e) {
      console.error('[SMS] database read failed, falling back to the sheet:', e.message);
    }
  }
  return smsFromSheet(startDay, endDay, opts);
}

module.exports = { smsCounts, smsFromSheet, smsFromDb, parseCount };
