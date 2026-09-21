// EasyPay Direct — read-only client for the reporting API.
//
// EasyPay Direct is the NMI gateway white-labelled: the same transact.php and
// query.php, the same variable names, and its replies are still wrapped in
// <nm_response>. This client is a trimmed copy of the (production-proven) NMI
// client written for the Outbound Experts portal, kept separate on purpose —
// nothing here is shared with that codebase.
//
// READ ONLY. It queries; it never charges, refunds or voids. The report has no
// business moving money.
const https = require('https');

const HOST = (process.env.EASYPAY_HOST || 'secure.easypaydirectgateway.com')
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const SECURITY_KEY = () => process.env.EASYPAY_SECURITY_KEY || '';

function configured() { return !!SECURITY_KEY(); }

function request({ path, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body || ''),
      },
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('EasyPay request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

// ── tiny XML readers (query.php answers XML; nothing else here needs a parser) ──
const xmlUnescape = s => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function xmlTagOne(body, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(body || '');
  return m ? m[1].trim() : '';
}
function xmlTagAll(body, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(body || ''))) out.push(m[1]);
  return out;
}

// The gateway's own timestamp format, and the one it expects back.
const stamp = (d) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
function parseStamp(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  // Date() cannot read "20260919143000" — left alone, every payment would be
  // stamped with the time it was imported instead of when it happened.
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

// One query.php call.
//
// THE TRAP: this API reports failures as HTTP 200 with an <error_response> body.
// A parser that only looks for <transaction> finds none and returns an empty
// list — so a rejected key is indistinguishable from a quiet week, and a sync
// can report "nothing new" every day while being completely broken. Fail loudly.
async function query(params) {
  if (!configured()) { const e = new Error('EASYPAY_SECURITY_KEY not set'); e.code = 'not_configured'; throw e; }
  const body = new URLSearchParams({ security_key: SECURITY_KEY(), ...params }).toString();
  const res = await request({ path: '/api/query.php', body });

  if (res.status >= 500) { const e = new Error(`EasyPay query HTTP ${res.status}`); e.code = 'gateway_error'; e.retryable = true; throw e; }
  const err = xmlTagOne(res.body, 'error_response');
  if (err) { const e = new Error(`EasyPay query rejected: ${err}`); e.code = 'query_rejected'; throw e; }
  if (!/<nm_response/i.test(res.body)) {
    const e = new Error(`Unexpected EasyPay response: ${res.body.slice(0, 160)}`); e.code = 'bad_response'; throw e;
  }
  return res.body;
}

// <transaction> → one row per money-moving action.
//
// A transaction holds one or more <action> blocks (sale, refund, void…), and the
// amount that counts is the action's, not the transaction header's.
function parseTransactions(body) {
  const out = [];
  for (const tx of xmlTagAll(body, 'transaction')) {
    const row = {
      transactionId: xmlTagOne(tx, 'transaction_id'),
      // The date-range report does NOT return <customer_vault_id>; the vault id
      // arrives as <customerid>. Both are read, because other report shapes do
      // return the documented field and the two must not diverge.
      vaultId: xmlTagOne(tx, 'customer_vault_id') || xmlTagOne(tx, 'customerid') || null,
      customerId: xmlTagOne(tx, 'customerid') || null,
      email: xmlUnescape(xmlTagOne(tx, 'email')).toLowerCase() || null,
      firstName: xmlUnescape(xmlTagOne(tx, 'first_name')) || null,
      lastName: xmlUnescape(xmlTagOne(tx, 'last_name')) || null,
      company: xmlUnescape(xmlTagOne(tx, 'company')) || null,
      orderId: xmlUnescape(xmlTagOne(tx, 'order_id')) || null,
      description: xmlUnescape(xmlTagOne(tx, 'order_description')) || '',
      subscriptionId: xmlTagOne(tx, 'subscription_id') || null,
      // The batch upload may carry the client's reference in one of these.
      merchantDefined: xmlTagAll(tx, 'merchant_defined_field_1').map(xmlUnescape)[0] || null,
    };
    for (const act of xmlTagAll(tx, 'action')) {
      const type = xmlTagOne(act, 'action_type').toLowerCase();
      const success = xmlTagOne(act, 'success');
      const amount = Number(xmlTagOne(act, 'amount') || 0);   // dollars, not cents
      if (!type) continue;
      out.push({
        ...row,
        actionType: type,                  // sale | refund | credit | void | auth | capture | settle
        success: success === '1',
        amount,
        at: parseStamp(xmlTagOne(act, 'date')),
        responseText: xmlUnescape(xmlTagOne(act, 'response_text')) || '',
      });
    }
  }
  return out;
}

// Every transaction in a window. The window is split into chunks because a wide
// range on a busy account returns a very large XML document in one go.
async function listTransactions(since, until, { chunkDays = 31 } = {}) {
  const start = since instanceof Date ? since : new Date(since + 'T00:00:00Z');
  const end = until ? (until instanceof Date ? until : new Date(until + 'T23:59:59Z')) : new Date();
  const rows = [];
  let from = new Date(start);
  while (from < end) {
    const to = new Date(Math.min(from.getTime() + chunkDays * 86400000, end.getTime()));
    const body = await query({ start_date: stamp(from), end_date: stamp(to) });
    rows.push(...parseTransactions(body));
    from = new Date(to.getTime() + 1000);
  }
  return rows;
}

// A named report shape (report_type=recurring lists subscriptions, and so on).
async function report(reportType, extra = {}) {
  return query({ report_type: reportType, ...extra });
}

module.exports = {
  configured, listTransactions, parseTransactions, query, report,
  xmlTagOne, xmlTagAll, parseStamp, stamp, HOST,
};
