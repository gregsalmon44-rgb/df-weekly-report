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
  if (db.enabled()) { try { await db.init(); } catch (e) { console.error('[DB] init failed:', e.message); } }
  setInterval(cronTick, 60 * 1000);
});

module.exports = { app, sendReportToSlack };
