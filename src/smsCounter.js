// Counting SMS sends as they happen.
//
// GoHighLevel calls the webhook once per message, which at Demand Flow's volume
// is tens of thousands of calls a day. Writing a row per call would spend the
// whole day in the database for no benefit, so counts are buffered in memory and
// flushed every 30 seconds as one increment per campaign per day.
//
// The cost of that choice is bounded: a crash loses at most one flush window —
// seconds of sends, on a figure only ever read as a weekly total. The webhook
// answers immediately either way, because a slow reply makes GHL retry and
// double-count.
const db = require('./db');
const { etDateStr } = require('./dates');

const FLUSH_MS = 30 * 1000;

// key: `${locationId}|${day}` → { locationId, day, count, campaign }
let buffer = new Map();
let timer = null;
let flushing = false;
const stats = { received: 0, flushed: 0, lastFlushAt: null, lastError: null, unknownLocation: 0 };

function record(locationId, campaign) {
  const loc = String(locationId || '').trim();
  const day = etDateStr();
  // A send we cannot attribute is still counted, under a bucket that shows up in
  // the comparison — silently dropping it would make the webhook look complete
  // when it is not.
  const key = (loc || 'unknown') + '|' + day;
  const cur = buffer.get(key) || { locationId: loc || 'unknown', day, count: 0, campaign: null };
  cur.count++;
  if (campaign && !cur.campaign) cur.campaign = campaign;
  buffer.set(key, cur);
  stats.received++;
  if (!loc) stats.unknownLocation++;
}

async function flush() {
  if (flushing || !buffer.size) return;
  if (!db.enabled()) { buffer.clear(); return; }
  flushing = true;
  const batch = [...buffer.values()];
  buffer = new Map();
  try {
    await db.incrementSmsSends(batch);
    stats.flushed += batch.reduce((t, b) => t + b.count, 0);
    stats.lastFlushAt = new Date().toISOString();
    stats.lastError = null;
  } catch (e) {
    // Put them back rather than lose them; the next flush tries again.
    for (const b of batch) {
      const key = b.locationId + '|' + b.day;
      const cur = buffer.get(key) || { ...b, count: 0 };
      cur.count += b.count;
      buffer.set(key, cur);
    }
    stats.lastError = e.message;
    console.error('[SMS] flush failed, counts kept for the next attempt:', e.message);
  } finally {
    flushing = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(flush, FLUSH_MS);
  // Whatever is buffered when the container is told to stop is worth one last
  // attempt; Railway gives a moment before killing the process.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flush().finally(() => process.exit(0)); });
  console.log('[SMS] counter started (flushing every 30s)');
}

function state() {
  return { ...stats, buffered: [...buffer.values()].reduce((t, b) => t + b.count, 0) };
}

module.exports = { record, flush, start, state };
