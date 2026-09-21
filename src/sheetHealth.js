// Does the spreadsheet still look the way this report expects?
//
// Columns are found by HEADER NAME, so inserting or reordering columns is safe.
// RENAMING one is not: the lookup simply returns "absent", and the report then
// carries on with that input missing. The dangerous case is "EasyPay Reference"
// — lose it and revenue silently falls back to matching on cardholder names,
// which mostly works, so nobody notices until a client is misattributed.
//
// This runs before every report and states plainly what it could not find.
const { fetchTab, columnIndex } = require('./sheets');
const { config } = require('./config');

const EXPECTED = [
  { tab: () => config.tabRoster, column: 'Campaign', severity: 'fatal',
    effect: 'no clients can be read at all' },
  { tab: () => config.tabRoster, column: 'LocationID', aliases: ['Location ID'], severity: 'major',
    effect: 'leads and data cost fall back to matching on campaign names' },
  { tab: () => config.tabRoster, column: 'Industry', severity: 'major',
    effect: 'every client groups under "Other"' },
  { tab: () => config.tabRoster, column: 'Status', severity: 'major',
    effect: 'no client can be identified as OFF' },
  { tab: () => config.tabRoster, column: 'EasyPay Reference', aliases: ['EasyPay Ref'], severity: 'major',
    effect: 'payments are matched by cardholder name only, so revenue may be misattributed' },
  { tab: () => config.tabRoster, column: 'State', severity: 'minor',
    effect: 'the per-state breakdown falls back to the state in the campaign name' },
  { tab: () => config.tabLeads, column: 'Date', severity: 'fatal',
    effect: 'no leads can be counted' },
  { tab: () => config.tabLeads, column: 'Campaign', severity: 'major',
    effect: 'leads with no LocationID cannot be attributed' },
  { tab: () => config.tabLeads, column: 'LocationID', aliases: ['Location ID'], severity: 'major',
    effect: 'leads are attributed by campaign name only' },
  { tab: () => config.tabSms, column: 'Date', severity: 'major',
    effect: 'SMS volumes cannot be read from the sheet' },
  { tab: () => config.tabSms, column: 'Campaign', severity: 'major',
    effect: 'SMS volumes cannot be attributed' },
  { tab: () => config.tabSms, column: 'Number of SMS sent out', aliases: ['SMS Sent', 'Number of SMS'],
    severity: 'major', effect: 'SMS volumes read as zero' },
];

async function checkSheet({ force = false } = {}) {
  const problems = [];
  const headers = new Map();

  for (const exp of EXPECTED) {
    const tab = exp.tab();
    try {
      if (!headers.has(tab)) {
        const rows = await fetchTab(tab, { force });
        headers.set(tab, rows[0] || []);
      }
      const idx = columnIndex(headers.get(tab), exp.column, ...(exp.aliases || []));
      if (idx === -1) {
        problems.push({
          severity: exp.severity,
          message: `The "${tab}" tab has no "${exp.column}" column — ${exp.effect}. ` +
                   `If it was renamed, either restore the name or tell the report the new one.`,
        });
      }
    } catch (e) {
      problems.push({ severity: 'fatal', message: `Could not read the "${tab}" tab: ${e.message}` });
    }
  }
  return problems;
}

module.exports = { checkSheet, EXPECTED };
