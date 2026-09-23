// Postgres: the two things a spreadsheet cannot hold.
//   sms_sends      — one row per campaign per day, written by the GHL webhook
//   ledger_entries — money in, pulled from EasyPay (and later Lumino)
//
// The database is OPTIONAL: with no DATABASE_URL the report still renders from
// the sheet alone, and the missing parts are reported as unavailable rather than
// shown as zero. A zero is indistinguishable from "we took no money this week",
// which is exactly the kind of wrong number that gets believed.
const { config } = require('./config');

let pool = null;
function enabled() { return !!config.databaseUrl; }

function getPool() {
  if (!enabled()) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Railway's internal hostnames present a self-signed certificate.
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
    });
    pool.on('error', e => console.error('[DB] idle client error:', e.message));
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not set');
  return p.query(text, params);
}

async function init() {
  if (!enabled()) { console.warn('[DB] DATABASE_URL not set — SMS counting and revenue are unavailable.'); return false; }
  await query(`
    CREATE TABLE IF NOT EXISTS sms_sends (
      location_id text NOT NULL,
      day date NOT NULL,
      count integer NOT NULL DEFAULT 0,
      campaign text,
      PRIMARY KEY (location_id, day)
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL,
      type text NOT NULL,
      amount numeric(12,2) NOT NULL,
      source text NOT NULL,
      external_id text,
      payer_id text,
      location_id text,
      description text,
      currency text DEFAULT 'usd',
      UNIQUE (source, external_id)
    )`);
  await query('CREATE INDEX IF NOT EXISTS ledger_entries_ts_idx ON ledger_entries (ts)');
  await query('CREATE INDEX IF NOT EXISTS ledger_entries_location_idx ON ledger_entries (location_id)');
  console.log('[DB] ready');
  return true;
}

// ── SMS ──────────────────────────────────────────────────────────────────────
async function getSmsSendsForRange(startDay, endDay) {
  const { rows } = await query(
    `SELECT location_id, SUM(count)::int AS count
       FROM sms_sends WHERE day BETWEEN $1 AND $2 GROUP BY location_id`,
    [startDay, endDay]);
  return rows;
}

// Adds to the day's running total (the webhook reports increments).
async function incrementSmsSends(deltas) {
  for (const d of deltas) {
    await query(
      `INSERT INTO sms_sends (location_id, day, count, campaign)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, day)
         DO UPDATE SET count = sms_sends.count + EXCLUDED.count,
                       campaign = COALESCE(EXCLUDED.campaign, sms_sends.campaign)`,
      [d.locationId, d.day, d.count, d.campaign || null]);
  }
}

// Sets the day's total outright — used by the one-off import of historical
// counts, where re-running the import must not double the numbers.
async function setSmsSendsBatch(rows) {
  for (const r of rows) {
    await query(
      `INSERT INTO sms_sends (location_id, day, count, campaign)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, day)
         DO UPDATE SET count = EXCLUDED.count,
                       campaign = COALESCE(EXCLUDED.campaign, sms_sends.campaign)`,
      [r.locationId, r.day, r.count, r.campaign || null]);
  }
  return rows.length;
}

// ── Revenue ──────────────────────────────────────────────────────────────────
// Money IN only. Fees and internal offsets are excluded here the same way OBE
// does it, so a client's own subscription payment can't read as lead spend.
async function getRevenueByLocation(startDay, endDay) {
  const { rows } = await query(
    `SELECT location_id,
            SUM(CASE WHEN type IN ('payment','topup','manual_income') THEN amount
                     WHEN type = 'refund' THEN amount ELSE 0 END) AS net
       FROM ledger_entries
      WHERE location_id IS NOT NULL
        AND (ts AT TIME ZONE 'America/New_York')::date BETWEEN $1 AND $2
      GROUP BY location_id`,
    [startDay, endDay]);
  return rows;
}

// Per day per location, for comparing the counter against the sheet.
async function getSmsByDay(startDay, endDay) {
  const { rows } = await query(
    `SELECT location_id, to_char(day, 'YYYY-MM-DD') AS day, SUM(count)::int AS count, MAX(campaign) AS campaign
       FROM sms_sends WHERE day BETWEEN $1 AND $2
       GROUP BY location_id, day ORDER BY day`,
    [startDay, endDay]);
  return rows;
}

async function countSmsRows() {
  const { rows } = await query('SELECT COUNT(*)::int AS n, COALESCE(SUM(count),0)::int AS total FROM sms_sends');
  return rows[0] || { n: 0, total: 0 };
}

async function countLedgerRows() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM ledger_entries');
  return rows[0] ? rows[0].n : 0;
}

module.exports = {
  enabled, init, query,
  getSmsSendsForRange, incrementSmsSends, setSmsSendsBatch, getSmsByDay, countSmsRows,
  getRevenueByLocation, countLedgerRows,
};
