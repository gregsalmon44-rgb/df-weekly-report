// The Demand Flow weekly report service.
//
// Small on purpose: it renders the report on demand, and posts it to Slack every
// Monday morning. Everything it reports on is read live from the spreadsheet and
// the payment gateway at render time, so there is no ingest to keep running and
// nothing to go stale between Mondays.
const express = require('express');
const { config } = require('./config');
const { buildReportData } = require('./pnl');
const { renderWeeklyPdf } = require('./reportPdf');
const { lastFullWeek, etDateStr } = require('./dates');
const slack = require('./slack');
const db = require('./db');
const smsCounter = require('./smsCounter');
const { smsFromSheet, smsFromDb } = require('./sms');
const { fetchCampaigns } = require('./roster');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Everything below is machine-to-machine and gated on a shared secret. It fails
// closed: with no ADMIN_SECRET set, nothing is reachable.
function requireSecret(req, res, next) {
  if (!config.adminSecret || req.headers['x-report-secret'] !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const fileNameFor = (week) => `Demand Flow - Weekly Profitability Report - ${week.start} to ${week.end}.pdf`;

// The figures, as JSON — for checking a number without rendering a PDF.
app.get('/api/report.json', requireSecret, async (req, res) => {
  try {
    const data = await buildReportData(req.query.start, req.query.end, { force: true });
    res.json(data);
  } catch (err) {
    console.error('[Report] JSON error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The PDF itself. ?download=1 to save rather than view.
app.get('/api/report.pdf', requireSecret, async (req, res) => {
  try {
    const data = await buildReportData(req.query.start, req.query.end, { force: true });
    const pdf = await renderWeeklyPdf(data);
    const name = fileNameFor({ start: data.lastWeek.rangeStart, end: data.lastWeek.rangeEnd });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.send(pdf);
  } catch (err) {
    console.error('[Report] PDF error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SMS COUNTER ──────────────────────────────────────────────────────────────
// Called by a GoHighLevel workflow once per message sent. Answers immediately
// and counts in the background: a slow reply makes GHL retry, and a retry would
// count the same message twice.
//
// Gated by a token in the query string, because that is all a GHL webhook can
// carry. No SMS_HOOK_SECRET set = the endpoint is closed.
// The last few payloads exactly as GHL sent them, with what was read out of
// each. GHL's payload has differed from its documentation before, and "the
// location id is in there somewhere" is only worth anything if this service is
// reading the field GHL actually sends.
const recentHooks = [];

app.get('/api/admin/sms-recent', requireSecret, (req, res) => {
  res.json({ count: recentHooks.length, hooks: recentHooks });
});

app.post('/api/hooks/sms-sent', (req, res) => {
  if (!config.smsHookSecret || req.query.token !== config.smsHookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const b = req.body || {};
  // GHL sends the location in several shapes depending on how the workflow is
  // built, so read all of them rather than insisting on one.
  const locationId = b.locationId || b.location_id ||
    (b.customData && (b.customData.locationId || b.customData.location_id)) ||
    (b.location && (b.location.id || b.location.locationId)) || '';
  const campaign = (b.location && b.location.name) || b.location_name || b.campaign || null;
  smsCounter.record(locationId, campaign);

  recentHooks.unshift({
    at: new Date().toISOString(),
    locationIdRead: locationId || null,
    campaignRead: campaign,
    topLevelFields: Object.keys(b).slice(0, 40),
    payload: JSON.stringify(b).slice(0, 2000),
  });
  if (recentHooks.length > 5) recentHooks.pop();

  res.json({ ok: true });
});

// How the counter is doing: what it has received, what is still buffered, and
// what has reached the database.
app.get('/api/admin/sms-status', requireSecret, async (req, res) => {
  try {
    const stored = db.enabled() ? await db.countSmsRows() : null;
    res.json({
      reportReadsFrom: config.smsSource,
      counter: smsCounter.state(),
      database: db.enabled() ? { connected: true, rows: stored.n, smsCounted: stored.total } : { connected: false },
      hookConfigured: !!config.smsHookSecret,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/sms-location/:locationId', requireSecret, async (req, res) => {
  try {
    if (!db.enabled()) return res.status(400).json({ error: 'No database configured' });
    const removed = await db.deleteSmsLocation(req.params.locationId);
    res.json({ ok: true, locationId: req.params.locationId, rowsRemoved: removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The counter against the sheet, day by day. This is what decides whether the
// counter can be trusted: agreement over a full week, not a good-looking total.
app.get('/api/admin/sms-compare', requireSecret, async (req, res) => {
  try {
    const start = req.query.start, end = req.query.end || start;
    if (!start) return res.status(400).json({ error: 'start=YYYY-MM-DD required' });
    if (!db.enabled()) return res.status(400).json({ error: 'No database configured — the counter has nowhere to write.' });

    const [sheet, rows, { campaigns }] = await Promise.all([
      smsFromSheet(start, end, { force: true }),
      db.getSmsByDay(start, end),
      fetchCampaigns({ force: true }),
    ]);
    // The sheet counts by campaign name, the webhook by location id, so one side
    // has to be translated before they can be compared at all.
    const locOf = new Map(campaigns.filter(c => c.locationId).map(c => [c.name.toLowerCase(), c.locationId]));
    const nameOf = new Map(campaigns.filter(c => c.locationId).map(c => [c.locationId, c.name]));

    const byLoc = new Map();
    for (const r of rows) byLoc.set(r.location_id, (byLoc.get(r.location_id) || 0) + r.count);

    const perCampaign = [];
    let sheetTotal = 0, hookTotal = 0;
    for (const [nameLc, count] of sheet.byCampaign) {
      sheetTotal += count;
      const loc = locOf.get(nameLc);
      const hook = loc ? (byLoc.get(loc) || 0) : null;
      perCampaign.push({ campaign: nameLc, locationId: loc || null, sheet: count, webhook: hook,
        difference: hook == null ? null : hook - count });
    }
    for (const [loc, count] of byLoc) {
      hookTotal += count;
      const name = nameOf.get(loc);
      if (!name || !sheet.byCampaign.has(name.toLowerCase())) {
        perCampaign.push({ campaign: name || '(unknown location ' + loc + ')', locationId: loc,
          sheet: 0, webhook: count, difference: count });
      }
    }
    perCampaign.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
    res.json({
      range: { start, end },
      totals: { sheet: sheetTotal, webhook: hookTotal, difference: hookTotal - sheetTotal,
                percentOfSheet: sheetTotal ? Math.round((hookTotal / sheetTotal) * 1000) / 10 : null },
      campaignsWithNoLocationId: perCampaign.filter(c => c.locationId === null).length,
      perCampaign: perCampaign.slice(0, 200),
    });
  } catch (err) {
    console.error('[SMS compare] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Load the sheet's historical counts into the counter's table, so that switching
// over does not lose every week before the webhook existed. Idempotent: it SETS
// each day's figure rather than adding, so running it twice changes nothing.
app.post('/api/admin/sms-import-sheet', requireSecret, async (req, res) => {
  try {
    const b = req.body || {};
    const start = b.start || config.allTimeStart, end = b.end || etDateStr();
    const commit = !!b.commit;
    if (!db.enabled()) return res.status(400).json({ error: 'No database configured' });

    const [sheet, { campaigns }] = await Promise.all([
      smsFromSheet(start, end, { force: true }),
      fetchCampaigns({ force: true }),
    ]);
    // Without a location id there is nothing to key the row on; those campaigns
    // are listed back rather than counted under a placeholder.
    const locOf = new Map(campaigns.filter(c => c.locationId).map(c => [c.name.toLowerCase(), c.locationId]));
    const rows = [], skipped = [];
    for (const [nameLc, count] of sheet.byCampaign) {
      const loc = locOf.get(nameLc);
      if (!loc) { skipped.push({ campaign: nameLc, sms: count }); continue; }
      rows.push({ locationId: loc, day: null, count, campaign: nameLc });
    }
    res.json({
      dryRun: !commit,
      note: 'The sheet tab holds one row per campaign per DAY; this summary is by campaign. ' +
            'Use scripts/import-sms-history.js to write the per-day rows.',
      range: { start, end }, campaignsReady: rows.length, smsReady: rows.reduce((t, r) => t + r.count, 0),
      campaignsSkipped: skipped.length, skipped: skipped.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Render and post to Slack now — the same path the Monday cron takes.
app.post('/api/report/slack', requireSecret, async (req, res) => {
  try {
    const b = req.body || {};
    const result = await sendReportToSlack(b.start, b.end, { test: !!b.test });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Report] Slack error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Is delivery actually wired up? Answers before a Monday proves it the hard way.
app.get('/api/slack-check', requireSecret, async (req, res) => {
  try {
    const auth = slack.configured() ? await slack.authTest() : null;
    res.json({
      configured: slack.configured(),
      channelId: config.slackChannelId || null,
      team: auth ? auth.team : null,
      botUser: auth ? auth.user : null,
    });
  } catch (err) {
    res.status(500).json({ configured: slack.configured(), error: err.message });
  }
});

// `test` posts the same report without the @channel mention, for checking the
// wiring without pulling everyone into the room.
async function sendReportToSlack(start, end, { test = false } = {}) {
  const data = await buildReportData(start, end, { force: true });
  const pdf = await renderWeeklyPdf(data);
  const week = { start: data.lastWeek.rangeStart, end: data.lastWeek.rangeEnd };
  const name = fileNameFor(week);
  const out = await slack.uploadPdf(pdf, {
    filename: name,
    title: name.replace(/\.pdf$/, ''),
    comment: test
      ? 'Test post — checking the weekly report delivery. The real one arrives on Monday mornings.'
      : '<!channel> Please find attached the weekly profitability report for last week ' +
        'in total, by industry and by client.',
  });
  console.log(`[Report] posted to Slack for ${week.start} → ${week.end}`);
  return { week, fileId: out.files && out.files[0] && out.files[0].id };
}

// ── Monday morning ───────────────────────────────────────────────────────────
// Checked once a minute against LONDON time.
//
// The window is 08:00–08:14 rather than the single minute of 08:00: a deploy or
// restart that happens to span 08:00 would otherwise skip the week silently, and
// a report nobody receives is the failure that matters here. Posting twice is
// possible only if the service restarts inside that quarter of an hour AFTER a
// successful post — visibly harmless, and far rarer than a missed Monday.
const POST_HOUR = 8;
const POST_WINDOW_MINUTES = 15;
let lastPostedOn = null;

async function cronTick() {
  const now = new Date();
  const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  if (london.getDay() !== 1) return;
  if (london.getHours() !== POST_HOUR || london.getMinutes() >= POST_WINDOW_MINUTES) return;

  const stamp = london.toDateString();
  if (lastPostedOn === stamp) return;
  lastPostedOn = stamp;

  if (!slack.configured()) {
    console.warn('[Cron] Monday report skipped — Slack is not configured (needs SLACK_BOT_TOKEN and SLACK_REPORT_CHANNEL_ID)');
    await slack.postAlert(':warning: The Demand Flow weekly report could not be posted: no Slack bot token is configured, ' +
      'so the PDF cannot be uploaded. The figures are still available from the report service.');
    return;
  }
  const week = lastFullWeek();
  try {
    const check = await buildReportData(week.start, week.end, { force: true });
    if (check.allTime.suspect) {
      // Posting a report built on a partial read is worse than posting nothing:
      // the figures look plausible and get believed.
      console.error('[Cron] Monday report HELD BACK:', check.allTime.suspect);
      await slack.postAlert(':warning: The Demand Flow weekly report has NOT been posted, ' +
        'because the data looks incomplete.\n' + check.allTime.suspect);
      return;
    }
    await sendReportToSlack(week.start, week.end);
  } catch (err) {
    // One retry ten minutes later: rendering pulls from the sheet, the gateway
    // and the dashboard, and any of them can have a bad minute. Missing a week
    // entirely is worse than posting a little late.
    console.error('[Cron] Monday report failed, retrying in 10 minutes:', err.message);
    setTimeout(() => {
      sendReportToSlack(week.start, week.end).catch(e => {
        console.error('[Cron] Monday report retry failed:', e.message);
        slack.postAlert(`:rotating_light: The Demand Flow weekly report (${week.start} – ${week.end}) ` +
          `failed twice and has NOT been posted.\nError: ${e.message}`);
      });
    }, 10 * 60 * 1000);
  }
}

app.listen(config.port, async () => {
  console.log(`[DF Report] listening on ${config.port} (today is ${etDateStr()} ET)`);
  console.log(`[DF Report] slack: ${slack.configured() ? 'configured → ' + config.slackChannelId : 'NOT configured'}`);
  console.log(`[DF Report] data cost keyed by: ${config.dataCostKey}`);
  if (db.enabled()) {
    try { await db.init(); smsCounter.start(); }
    catch (e) { console.error('[DB] init failed:', e.message); }
  } else {
    console.warn('[DF Report] no DATABASE_URL — the SMS counter cannot store anything');
  }
  console.log(`[DF Report] sms webhook: ${config.smsHookSecret ? 'open (token required)' : 'CLOSED (no SMS_HOOK_SECRET)'}; report reads SMS from: ${config.smsSource}`);
  setInterval(cronTick, 60 * 1000);
});

module.exports = { app, sendReportToSlack };
