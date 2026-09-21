// Posting the report into Slack.
//
// A PDF cannot go through an incoming webhook — webhooks only carry text — so
// this uses a bot token and Slack's external-upload flow. The bot must be a
// member of the channel it posts to.
const axios = require('axios');
const { config } = require('./config');

function configured() {
  return !!(config.slackBotToken && config.slackChannelId);
}

async function slackApi(method, params, asJson) {
  if (!config.slackBotToken) throw new Error('SLACK_BOT_TOKEN is not set');
  const headers = { Authorization: 'Bearer ' + config.slackBotToken };
  let body;
  if (asJson) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params).toString();
  }
  const res = await axios.post('https://slack.com/api/' + method, body, { headers, validateStatus: () => true });
  if (!res.data || !res.data.ok) throw new Error(`Slack ${method} failed: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function authTest() {
  return slackApi('auth.test', {}, false);
}

// Three steps: reserve a URL, PUT the bytes, then share it into the channel.
async function uploadPdf(buffer, { filename, title, comment }) {
  if (!configured()) throw new Error('SLACK_BOT_TOKEN and SLACK_REPORT_CHANNEL_ID must both be set');

  const up = await slackApi('files.getUploadURLExternal', { filename, length: buffer.length }, false);

  const boundary = '----dfReport' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    'Content-Type: application/pdf\r\n\r\n');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipart = Buffer.concat([head, buffer, tail]);

  const put = await axios.post(up.upload_url, multipart, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: () => true,
  });
  if (put.status < 200 || put.status >= 300) throw new Error('Slack upload failed: HTTP ' + put.status);

  return slackApi('files.completeUploadExternal', {
    files: [{ id: up.file_id, title: title || filename }],
    channel_id: config.slackChannelId,
    initial_comment: comment || '',
  }, true);
}

module.exports = { configured, authTest, uploadPdf, slackApi };
