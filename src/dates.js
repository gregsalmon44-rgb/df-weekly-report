// Every figure on this report is bucketed by EASTERN calendar day, because that
// is the day the sheet's own timestamps are written in. Date maths is done on
// "YYYY-MM-DD" strings rather than Date objects so daylight saving can never
// shift a row into the wrong day.
const TZ = 'America/New_York';

function etDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA renders as YYYY-MM-DD
}

function shiftDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

// The report week: the most recently FINISHED Monday–Sunday.
function lastFullWeek(today = etDateStr()) {
  const dow = dayOfWeek(today);
  const end = shiftDateStr(today, -(dow === 0 ? 7 : dow)); // the Sunday just gone
  return { start: shiftDateStr(end, -6), end };
}

// The sheet writes dates in several shapes by hand: "09/19/26 7:20 PM",
// "2/20/26", "9/19/2026". Anything unrecognised returns null so the caller can
// count it as unparseable instead of silently dropping it into the wrong week.
function sheetDateOnly(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (us) {
    const mm = Number(us[1]), dd = Number(us[2]);
    let yy = Number(us[3]);
    if (yy < 100) yy += 2000;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  // Google serial numbers (days since 1899-12-30) appear when a cell is copied
  // from a formula rather than typed.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
      return dt.toISOString().slice(0, 10);
    }
  }
  return null;
}

module.exports = { TZ, etDateStr, shiftDateStr, dayOfWeek, lastFullWeek, sheetDateOnly };
