// One place to read configuration, so no other module touches process.env and
// every default is visible in a single list.
require('dotenv').config();

const num = (v, dflt) => { const n = Number(v); return isFinite(n) && n > 0 ? n : dflt; };

const config = {
  sheetId:      process.env.SHEET_ID || '1xjnpjG5qI7fWIP0V70AorZzfDyq5PRpcfuXG2QgUQWk',
  tabRoster:    process.env.SHEET_TAB_ROSTER || 'SMS Schedule View',
  tabLeads:     process.env.SHEET_TAB_LEADS  || 'SMS Leads',
  tabSms:       process.env.SHEET_TAB_SMS    || 'SMS Sent Out',
  sheetsApiKey: process.env.GOOGLE_SHEETS_API_KEY || '',

  smsUnitCost:  num(process.env.SMS_UNIT_COST, 0.0070),
  allTimeStart: process.env.ALL_TIME_START || '2026-07-01',

  phantomdashUrl:    (process.env.PHANTOMDASH_URL || '').replace(/\/+$/, ''),
  phantomdashSecret: process.env.PHANTOMDASH_COST_SECRET || '',
  // 'campaign' until the LocationID column is filled in and the dashboard has
  // imported it; 'location' is the stronger key and should be switched to then.
  // 'both' uses the location figure where a campaign has an id and the campaign
  // name only where it does not — neither keying covers everything alone.
  dataCostKey: ['location', 'campaign', 'both'].includes(process.env.DATA_COST_KEY)
    ? process.env.DATA_COST_KEY : 'both',

  databaseUrl: process.env.DATABASE_URL || '',

  slackBotToken:  process.env.SLACK_BOT_TOKEN || '',
  slackChannelId: process.env.SLACK_REPORT_CHANNEL_ID || '',
  // A plain incoming webhook, used only to raise the alarm in Slack when the
  // Monday run fails. It cannot carry the PDF — that needs the bot token above.
  slackAlertWebhook: process.env.SLACK_ALERT_WEBHOOK || '',

  adminSecret: process.env.ADMIN_SECRET || '',
  port: num(process.env.PORT, 4100),
};

module.exports = { config };
