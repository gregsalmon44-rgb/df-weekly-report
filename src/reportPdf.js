// Weekly Profitability Report → PDF.
//
// Ported from the Outbound Experts report (same approved layout: all-time and
// last-week side by side, summary by industry, then detail by client), with
// three deliberate differences:
//   • Demand Flow branding — the logo sits on white, small, at the left.
//   • The SMS unit cost in the footnote is INTERPOLATED from config, so the
//     stated price cannot drift from the price actually used.
//   • A "Reporting notes" block prints what the report could not account for
//     (unmatched leads, missing revenue, missing data cost) instead of letting
//     those gaps pass as zeroes.
const fs = require('fs');
const path = require('path');

const MAX_IND_ROWS = 11;      // industry rows that fit on page 1; the rest roll into "Other"
const ACCENT_ALL = '#0b1220'; // all-time columns
const ACCENT_WEEK = '#16a34a';// last-week columns

const n = v => Math.round(v).toLocaleString('en-GB');
const money = v => '$' + Math.round(v).toLocaleString('en-GB');
const money1 = v => (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-GB');
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function d(ds) { const [, m, day] = ds.split('-').map(Number); return day + ' ' + MON[m - 1]; }
function dY(ds) { const [y, m, day] = ds.split('-').map(Number); return day + ' ' + MON[m - 1] + ' ' + y; }

const ZERO = { leads: 0, sms: 0, deposits: 0, cost: 0, dataCost: 0, netProfit: 0 };
function addStats(a, b) {
  b = b || ZERO;
  return { leads: a.leads + b.leads, sms: a.sms + b.sms, deposits: a.deposits + b.deposits,
           cost: a.cost + b.cost, dataCost: (a.dataCost || 0) + (b.dataCost || 0),
           netProfit: a.netProfit + b.netProfit };
}

let _logo = null;
function loadLogo() {
  if (_logo !== null) return _logo;
  try { _logo = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-b64.txt'), 'utf8').trim(); }
  catch (e) { _logo = ''; }
  return _logo;
}

function buildReportHtml(data, logoUri) {
  const at = data.allTime, lw = data.lastWeek;
  logoUri = logoUri != null ? logoUri : loadLogo();

  const sumOf = (clients) => clients.reduce((t, c) => addStats(t, c), { ...ZERO });
  function splitOff(industries) {
    const active = []; let off = null;
    for (const ind of industries) {
      const act = ind.clients.filter(c => !c.off);
      for (const c of ind.clients) if (c.off) off = addStats(off || { ...ZERO }, c);
      if (act.length) active.push({ industry: ind.industry, clients: act, totals: sumOf(act) });
    }
    return { active, off };
  }
  const atS = splitOff(at.industries);
  const lwS = splitOff(lw.industries);
  // Rows are paired across the two periods by entity KEY, not by display name —
  // a client who adds a campaign changes their name and would otherwise lose
  // their last-week column.
  const lwActiveByKey = new Map();
  for (const i of lwS.active) for (const c of i.clients) lwActiveByKey.set(c.key, c);
  const lwActiveIndTotals = new Map(lwS.active.map(i => [i.industry, i.totals]));

  // One period's five cells: Leads · SMS/Lead · Revenue · Cost · Net.
  // Cost is SMS + data combined; the split is in the notes, not in the table.
  function cells(stat, wcls) {
    wcls = wcls || '';
    if (!stat) return `<td class="num ${wcls}">–</td>`.repeat(4) + `<td class="num net ${wcls}">–</td>`;
    const spl = stat.leads > 0 ? n(stat.sms / stat.leads) : '—';
    const totalCost = (stat.cost || 0) + (stat.dataCost || 0);
    return `<td class="num ${wcls}">${n(stat.leads)}</td>` +
           `<td class="num ${wcls}">${spl}</td>` +
           `<td class="num ${wcls}">${money(stat.deposits)}</td>` +
           `<td class="num ${wcls}">${money(totalCost)}</td>` +
           `<td class="num net ${wcls} ${stat.netProfit < 0 ? 'neg' : ''}">${money1(stat.netProfit)}</td>`;
  }

  const grandRow = (label, a, b) => `<tr class="grand"><td>${label}</td>${cells(a)}${cells(b, 'gw')}</tr>`;

  // Volume-only cells for the per-industry sub-lines: Leads and SMS/Lead filled,
  // the three money columns deliberately blank.
  // boxl/boxr draw a light box around just the two volume columns, so the
  // breakdown reads as a block of figures without shading the whole row.
  function volumeCells(stat) {
    if (!stat) return '<td class="num boxl">–</td><td class="num boxr">–</td>' + '<td class="num"></td>'.repeat(3);
    const spl = stat.leads > 0 ? n(stat.sms / stat.leads) : '—';
    return `<td class="num boxl">${n(stat.leads)}</td><td class="num boxr">${spl}</td>` + '<td class="num"></td>'.repeat(3);
  }

  const HEAD = `
    <thead>
      <tr class="grouphdr">
        <th class="gh-sp"></th>
        <th class="gh-all" colspan="5">All-Time · since ${d(at.rangeStart)}</th>
        <th class="gh-lw" colspan="5">Last Week</th>
      </tr>
      <tr>
        <th class="l">NAME_PLACEHOLDER</th>
        <th>Leads</th><th>SMS/Lead</th><th>Revenue</th><th>Cost</th><th>Net Profit</th>
        <th class="vsep">Leads</th><th>SMS/Lead</th><th>Revenue</th><th>Cost</th><th>Net Profit</th>
      </tr>
    </thead>`;

  // PAGE 1 — by industry. OFF clients are pulled out into one line so the active
  // industries plus OFF still reconcile to the grand total.
  let indRows = atS.active.map(i => ({ name: i.industry, at: i.totals, lw: lwActiveIndTotals.get(i.industry) || null }));
  if (indRows.length > MAX_IND_ROWS) {
    const keep = indRows.slice(0, MAX_IND_ROWS - 1);
    const rest = indRows.slice(MAX_IND_ROWS - 1);
    keep.push({
      name: `Other (${rest.length} industries)`,
      at: rest.reduce((t, x) => addStats(t, x.at), { ...ZERO }),
      lw: rest.reduce((t, x) => addStats(t, x.lw), { ...ZERO }),
    });
    indRows = keep;
  }
  let industrySummary = indRows.map(row =>
    `<tr class="isum"><td class="iname">${esc(row.name)}</td>${cells(row.at)}${cells(row.lw)}</tr>`
  ).join('');
  if (atS.off) {
    industrySummary += `<tr class="isum"><td class="iname">OFF — no longer active</td>${cells(atS.off)}${cells(lwS.off)}</tr>`;
  }

  // PAGE 2+ — by client, active only.
  let detail = '';
  for (const ind of atS.active) {
    detail += `<tr class="grp"><td class="grp-name">${esc(ind.industry)}</td>${cells(ind.totals)}${cells(lwActiveIndTotals.get(ind.industry))}</tr>`;
    for (const c of ind.clients) {
      const lwc = lwActiveByKey.get(c.key);
      const hasBreak = c.industryBreakdown && c.industryBreakdown.length > 1;
      detail += `<tr${hasBreak ? ' class="hasbreak"' : ''}><td class="cname">${esc(c.name)}</td>${cells(c)}${cells(lwc)}</tr>`;
      // Per-industry volume for a client that spans several. Leads and SMS/lead
      // only: the money cells are left empty because revenue arrives as one
      // payment and splitting it between industries would be invented.
      if (hasBreak) {
        const lwByInd = new Map(((lwc && lwc.industryBreakdown) || []).map(b => [b.label || b.industry, b]));
        c.industryBreakdown.forEach((b, i) => {
          const last = i === c.industryBreakdown.length - 1;
          const lb = lwByInd.get(b.label || b.industry);
          detail += `<tr class="subind${i === 0 ? ' subind-first' : ''}${last ? ' subind-last' : ''}">` +
            `<td class="subname">${esc(b.label || b.industry)}</td>` +
            volumeCells(b) + volumeCells(lb) + '</tr>';
        });
      }
    }
  }
  const atActiveGrand = atS.active.reduce((t, i) => addStats(t, i.totals), { ...ZERO });
  const lwActiveGrand = lwS.active.reduce((t, i) => addStats(t, i.totals), { ...ZERO });

  // ── Reporting notes ────────────────────────────────────────────────────────
  // Anything the report could not account for is stated on the page. A missing
  // input that prints as a zero is worse than one that prints as a warning.
  const notes = [];
  const ds = at.dataSpend;
  if (!ds || !ds.available) {
    notes.push(`<b>Data cost unavailable</b> (${esc((ds && ds.reason) || 'unknown')}) — the Cost column and Net Profit exclude data cost, so profit is overstated.`);
  } else if (ds.totals && ds.totals.unallocated > 0) {
    notes.push(`${money(ds.totals.unallocated)} of data spend could not be matched to a client and is excluded from the client rows.`);
  }
  const rs = at.revenueSource;
  if (!rs || !rs.available) {
    notes.push(`<b>Revenue unavailable</b> (${esc((rs && rs.reason) || 'unknown')}) — every Revenue and Net Profit figure below reads as zero and cannot be relied on yet.`);
  } else if (rs.stats) {
    const s = rs.stats;
    if (s.unmatchedAmount) {
      notes.push(`${money(s.unmatchedAmount)} of payments could not be matched to a client${s.unmatchedSample && s.unmatchedSample.length ? ' (' + esc(s.unmatchedSample.slice(0, 3).join(', ')) + ')' : ''} and is excluded from Revenue.`);
    }
    if (s.unknownVaults && s.unknownVaults.length) {
      notes.push(`${s.unknownVaults.length} payer(s) were matched by name because their card is not listed in the sheet's EasyPay Reference column: ` +
        esc(s.unknownVaults.slice(0, 4).map(u => `${u.client} (${u.vault})`).join(', ')) + '.');
    }
    if (s.manualAmount) {
      notes.push(`${money(s.manualAmount)} of Revenue (${s.manual} payment${s.manual === 1 ? '' : 's'}) was taken through Lumino and entered by hand, as Lumino has no API to read from.`);
    }
    if (s.manualUnmatched) {
      notes.push(`<b>${s.manualUnmatched} hand-entered payment(s) name a client that is not in the sheet</b> and are listed as unallocated below.`);
    }
    if (s.pendingUsed && s.pendingUsed.length) {
      notes.push(`<b>${esc(s.pendingUsed.join(', '))}</b> paid but ${s.pendingUsed.length > 1 ? 'are' : 'is'} not in the master sheet yet — ` +
        `counted in Revenue, but with no leads, SMS or industry until added.`);
    }
  }
  const ss = at.smsSource;
  if (ss && ss.source === 'sheet') {
    notes.push('SMS volumes come from the manually maintained "SMS Sent Out" tab, not from an automatic counter.');
  }
  const att = at.attribution || {};
  if (att.leadsUnmatched) {
    notes.push(`${n(att.leadsUnmatched)} lead(s) could not be matched to a client${att.leadsUnmatchedSample && att.leadsUnmatchedSample.length ? ' (e.g. ' + esc(att.leadsUnmatchedSample.slice(0, 4).join(', ')) + ')' : ''} and are not counted in any row.`);
  }
  const keyedByLocation = ds && ds.keyedBy === 'location';
  for (const w of (at.warnings || []).slice(0, 4)) {
    if (!keyedByLocation && /have no LocationID on any campaign/.test(w)) continue;
    notes.push(esc(w));
  }
  // Kept to the END of the report, on its own page: these are caveats for
  // whoever questions a figure, not something to read before the figures.
  const notesBlock = notes.length
    ? `<div class="section-title pagebreak">Reporting notes</div>
       <div class="notes"><ul>${notes.map(x => `<li>${x}</li>`).join('')}</ul></div>`
    : '';

  // ── Unallocated payments ───────────────────────────────────────────────────
  // Money taken that belongs to nobody the report knows about. Known non-revenue
  // (test cards, another agency's payments on this gateway) is filtered out by
  // config/payer-rules.json, so whatever appears here is a real question: a new
  // client to add, or a payment to chase. The section is omitted when empty.
  const unal = (at.revenueSource && at.revenueSource.stats && at.revenueSource.stats.unallocated) || [];
  const unalTotal = unal.reduce((t, u) => t + u.amount, 0);
  const unallocatedSection = unal.length ? `
  <div class="section-title pagebreak">Unallocated payments — ${money(unalTotal)} since ${d(at.rangeStart)}</div>
  <div class="note" style="margin-top:0">These payments could not be matched to a client. Each one is either a
  new client who needs adding to the master sheet, or a payment taken on a card nobody recognises.
  They are <b>excluded</b> from Revenue and Net Profit above.</div>
  <table class="wo">
    <colgroup><col class="wd"><col class="wc"><col class="we"><col class="wa"><col class="wr"></colgroup>
    <thead><tr><th class="l">Date</th><th class="l">Cardholder</th><th class="l">Email</th><th>Amount</th><th class="l">Description</th></tr></thead>
    <tbody>${unal.slice(0, 40).map(u => `<tr>
      <td>${esc(u.date)}</td><td class="cname">${esc(u.name || '—')}</td>
      <td class="reason">${esc(u.email || '—')}</td>
      <td class="num net">${money1(u.amount)}</td>
      <td class="reason">${esc(u.description || '—')}</td></tr>`).join('')}
    </tbody>
  </table>` : '';

  function card(title, sub, s, accent) {
    const spl = s.leads > 0 ? n(s.sms / s.leads) : '—';
    return `
    <div class="card">
      <div class="card-head" style="border-color:${accent}">
        <div class="card-title">${esc(title)}</div><div class="card-sub">${esc(sub)}</div>
      </div>
      <div class="kpis" style="color:${accent}">
        <div class="kpi"><span>Leads</span><b>${n(s.leads)}</b></div>
        <div class="kpi"><span>SMS Sent</span><b>${n(s.sms)}</b></div>
        <div class="kpi"><span>SMS / Lead</span><b>${spl}</b></div>
      </div>
    </div>`;
  }

  const unitCost = data.smsUnitCost != null ? data.smsUnitCost : 0.0065;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4 landscape; margin: 11mm 11mm 12mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1e293b; margin: 0; font-size: 10px; }

/* The logo is a placeholder and sits on its own white ground, so the header is
   a light bar with a rule under it rather than the dark block OBE uses. */
.topbar { background: #fff; color: #0b1220; display: flex; align-items: center; justify-content: space-between;
  padding: 6px 4px 12px; border-bottom: 2px solid ${ACCENT_ALL}; }
.topbar img { height: 54px; }
.topbar .rt { text-align: right; }
.topbar h1 { font-size: 20px; margin: 0; font-weight: 700; letter-spacing: .2px; }
.topbar .wk { font-size: 17px; color: #334155; margin-top: 4px; font-weight: 600; }

.cards { display: flex; gap: 16px; margin: 14px 0 6px; break-inside: avoid; page-break-inside: avoid; }
.card { flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; background: #fff; }
.card-head { padding: 9px 14px; border-bottom: 3px solid; background: #f8fafc; }
.card-title { font-size: 13px; font-weight: 700; }
.card-sub { font-size: 10px; color: #64748b; margin-top: 1px; }
.kpis { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1px; background: #eef2f7; padding: 1px; margin: 0; }
.kpi { background: #fff; padding: 12px 14px 14px; display: flex; flex-direction: column; }
.kpi span { font-size: 9.5px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
.kpi b { font-size: 26px; font-weight: 800; line-height: 1.05; margin-top: 4px; }

.note { font-size: 11.5px; color: #475569; margin: 12px 2px 2px; line-height: 1.5; }
.notes { border: 1px solid #e2e8f0; background: #f8fafc; border-radius: 8px; padding: 10px 14px; margin: 4px 0 2px; }
.notes ul { margin: 4px 0 0; padding-left: 16px; }
.notes li { font-size: 10.5px; color: #475569; line-height: 1.6; margin-bottom: 3px; }

.section-title { font-size: 13px; font-weight: 700; margin: 14px 0 6px; color: #0b1220;
  display: flex; align-items: center; gap: 8px; }
.section-title::after { content: ""; flex: 1; height: 1px; background: #e2e8f0; }
.pagebreak { break-before: page; page-break-before: always; }

table.rpt { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.rpt col.cn { width: 15%; }
table.sumtbl { break-inside: avoid; page-break-inside: avoid; }
.rpt thead th { font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; color: #64748b;
  padding: 4px 6px; border-bottom: 1.5px solid #cbd5e1; text-align: right; white-space: nowrap; }
.rpt thead th.l { text-align: left; }
.rpt tr.grouphdr th { text-align: center; font-size: 9px; letter-spacing: .8px; color: #fff; padding: 4px; border-bottom: none; }
.gh-all { background: ${ACCENT_ALL}; }
.gh-lw { background: ${ACCENT_WEEK}; }
.gh-sp { background: #fff; }
.rpt tbody td { padding: 3.5px 6px; border-bottom: 1px solid #e2e8f0; color: #111827; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.net { font-weight: 700; }
.rpt tbody td.neg { color: #dc2626; }
td.cname, td.iname { color: #111827; overflow: hidden; text-overflow: ellipsis; }
tr.isum td { border-bottom: 1px solid #e8eef7; }
tr.isum .iname { font-weight: 700; font-size: 11px; }
tr.grp td { background: #d7e3f4; font-weight: 700; border-bottom: 1px solid #b9cbe6; border-top: 2px solid #b9cbe6; color: #0b1220; }
tr.grp .grp-name { font-size: 10.5px; }
tr.grand td { background: ${ACCENT_ALL}; color: #fff; font-weight: 800; font-size: 11.5px; padding: 7px 6px; border: none; }
tr.grand td.gw { background: ${ACCENT_WEEK}; }
.vsep { border-left: 2px solid #cbd5e1 !important; }

/* Per-industry sub-lines under a client spanning several industries. No fill and
   no rule down the margin — just a light box around the two volume columns, so
   the figures read as one block without another band of colour in the table. */
tr.subind td { border-bottom: none; padding-top: 2.5px; padding-bottom: 2.5px; color: #475569; font-size: 9.5px; }
tr.subind td.boxl { border-left: 1px solid #e2e8f0; }
tr.subind td.boxr { border-right: 1px solid #e2e8f0; }
tr.subind-first td.boxl, tr.subind-first td.boxr { border-top: 1px solid #e2e8f0; }
tr.subind-last td.boxl, tr.subind-last td.boxr { border-bottom: 1px solid #e2e8f0; }
td.subname { padding-left: 20px !important; font-style: italic; }

/* Unallocated payments table. Fixed layout + a shared colgroup so the columns
   do not stagger as rows come and go week to week. */
table.wo { width: 100%; border-collapse: collapse; table-layout: fixed; }
table.wo col.wd { width: 9%; }
table.wo col.wc { width: 20%; }
table.wo col.we { width: 24%; }
table.wo col.wa { width: 9%; }
table.wo col.wr { width: 38%; }
table.wo th { font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; color: #64748b; padding: 4px 6px; border-bottom: 1.5px solid #cbd5e1; text-align: right; }
table.wo th.l { text-align: left; }
table.wo td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; color: #111827; }
table.wo td.reason, table.wo td.cname { overflow-wrap: break-word; color: #475569; }
table.wo td.cname { color: #111827; }
</style></head><body>

  <div class="topbar">
    ${logoUri ? `<img src="${logoUri}" alt="Demand Flow">` : '<div></div>'}
    <div class="rt">
      <h1>Weekly Profitability Report</h1>
      <div class="wk">Week of ${d(lw.rangeStart)} – ${dY(lw.rangeEnd)}</div>
    </div>
  </div>

  <div class="cards">
    ${card('All-Time', 'Since ' + dY(at.rangeStart), at.grand, ACCENT_ALL)}
    ${card('Last Week', d(lw.rangeStart) + ' – ' + dY(lw.rangeEnd), lw.grand, ACCENT_WEEK)}
  </div>

  ${(at.computedRules || []).map(r => `<div class="note">${r.footnoteLead ? `<b>${esc(r.footnoteLead)}</b> ` : ''}${esc(r.footnote)}</div>`).join('')}

  <div class="note">The cost shown below by industry and by client is based on the actual data cost
  (per Phantom Data) and assumes an SMS cost of $${Number(unitCost).toFixed(4)} per SMS sent. It therefore excludes other
  costs (such as if there is more than 1 segment, phone number costs, and brand/campaign registration
  costs).</div>

  <div class="section-title">Summary by Industry</div>
  <table class="rpt sumtbl"><colgroup><col class="cn"></colgroup>
    ${HEAD.replace('NAME_PLACEHOLDER', 'Industry')}
    <tbody>${grandRow('TOTAL', at.grand, lw.grand)}${industrySummary}</tbody>
  </table>

  <div class="section-title pagebreak">Profitability by Client</div>
  <table class="rpt"><colgroup><col class="cn"></colgroup>
    ${HEAD.replace('NAME_PLACEHOLDER', 'Client')}
    <tbody>${grandRow('TOTAL', atActiveGrand, lwActiveGrand)}${detail}</tbody>
  </table>

  ${unallocatedSection}

  ${notesBlock}

</body></html>`;
}

async function renderWeeklyPdf(data) {
  const puppeteer = require('puppeteer');
  const html = buildReportHtml(data, loadLogo());
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // puppeteer v23+ returns a Uint8Array; Buffer is what res.send() and the
    // Slack upload both expect.
    const out = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return Buffer.from(out);
  } finally {
    await browser.close();
  }
}

module.exports = { buildReportHtml, renderWeeklyPdf, loadLogo };
