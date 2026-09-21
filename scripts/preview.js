// Local preview: build the report from live data and write a PDF next to the
// project, without deploying anything or touching Slack.
//
//   node scripts/preview.js                 → the last finished week
//   node scripts/preview.js 2026-09-08 2026-09-14
const path = require('path');
const fs = require('fs');
const { buildReportData } = require('../src/pnl');
const { renderWeeklyPdf } = require('../src/reportPdf');

(async () => {
  const [start, end] = process.argv.slice(2);
  const t0 = Date.now();
  const data = await buildReportData(start, end, { force: true });

  const at = data.allTime, lw = data.lastWeek;
  console.log(`Week ${lw.rangeStart} → ${lw.rangeEnd} | all-time since ${at.rangeStart}`);
  console.log(`  clients: ${at.clientCount} all-time, ${lw.clientCount} active last week`);
  console.log(`  leads:   ${at.grand.leads} all-time, ${lw.grand.leads} last week`);
  console.log(`  sms:     ${at.grand.sms} all-time (${at.smsSource.source}), ${lw.grand.sms} last week`);
  console.log(`  revenue: ${at.revenueSource.available ? '$' + at.grand.deposits : 'unavailable (' + at.revenueSource.reason + ')'}`);
  console.log(`  data:    ${at.dataSpend.available ? '$' + at.grand.dataCost : 'unavailable (' + at.dataSpend.reason + ')'}`);
  if (at.attribution.leadsUnmatched) console.log(`  ⚠ ${at.attribution.leadsUnmatched} unmatched leads (all-time)`);
  for (const w of at.warnings) console.log('  ⚠ ' + w);

  const pdf = await renderWeeklyPdf(data);
  const name = `Demand Flow - Weekly Profitability Report - ${lw.rangeStart} to ${lw.rangeEnd}.pdf`;
  const out = path.join(__dirname, '..', 'previews', name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pdf);
  console.log(`\nPDF: ${out} (${(pdf.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
})().catch(e => { console.error(e); process.exit(1); });
