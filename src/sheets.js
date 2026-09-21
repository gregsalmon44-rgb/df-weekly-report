// Reading the Demand Flow master spreadsheet.
//
// Tabs are fetched as CSV through Google's public export endpoint, which needs no
// credentials while the sheet stays link-readable. An API key is used instead when
// one is configured, so locking the sheet down later is a config change, not a
// rewrite.
//
// Everything here is read-only. This service never writes to the sheet.
const { config } = require('./config');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // tab → { at, rows }

// A CSV parser rather than a split(','), because the sheet's own headers contain
// commas and embedded newlines ("Leads\nToday"), which a naive split shreds —
// silently shifting every column after it.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function tabUrl(tab) {
  const id = encodeURIComponent(config.sheetId);
  if (config.sheetsApiKey) {
    return `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tab)}` +
           `?key=${encodeURIComponent(config.sheetsApiKey)}&majorDimension=ROWS`;
  }
  // headers=1 is NOT optional: without it this endpoint decides for itself which
  // row is the header, and silently returns BLANK labels for columns whose data
  // looks like a different type than their heading. "EasyPay Reference" came back
  // as an empty header that way, so every payment failed to match a client while
  // the sheet looked perfectly fine.
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq` +
         `?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
}

// Returns rows as arrays of strings, header row included.
async function fetchTab(tab, { force = false } = {}) {
  const hit = cache.get(tab);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const res = await fetch(tabUrl(tab), { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet tab "${tab}" fetch failed: HTTP ${res.status}`);
  const body = await res.text();

  // A sheet that has lost public access answers 200 with a sign-in HTML page
  // rather than an error — the exact shape that reads as "no rows" downstream.
  if (/^\s*</.test(body)) {
    throw new Error(`Sheet tab "${tab}" returned HTML, not CSV — the sheet is probably no longer link-readable.`);
  }

  let rows;
  if (config.sheetsApiKey) {
    const json = JSON.parse(body);
    rows = json.values || [];
  } else {
    rows = parseCsv(body);
  }
  cache.set(tab, { at: Date.now(), rows });
  return rows;
}

// Header lookup by NAME, not by position: these tabs are edited by hand and
// columns move. Matching is case- and space-insensitive. Returns -1 if absent,
// which callers must handle explicitly rather than reading column 0 by accident.
function columnIndex(headerRow, ...names) {
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const header = (headerRow || []).map(norm);
  for (const name of names) {
    const i = header.indexOf(norm(name));
    if (i !== -1) return i;
  }
  return -1;
}

module.exports = { fetchTab, parseCsv, columnIndex, CACHE_TTL_MS };
