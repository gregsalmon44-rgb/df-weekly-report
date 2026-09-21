// Revenue: money actually collected through EasyPay, attributed to a client.
//
// No database is involved. The gateway is queried for the window the report
// covers (three months of history comes back in about 15 seconds), which means
// there is nothing to keep in sync, nothing to backfill, and no way for a missed
// webhook to leave a gap. If that ever gets slow, this is the piece to cache.
//
// ATTRIBUTION, strongest first:
//   1. the vault id on the payment == the campaign's "EasyPay Reference"
//   2. the cardholder's name == the client's name (campaigns are named after the
//      person, so "Dani Wegner" on a card matches "Dani Wegner 3 - Berger Homes")
//   3. no match — counted and REPORTED, never silently dropped
//
// Measured over 1 Jul–19 Sep 2026: 83% by reference, 16% by name, 1% unmatched.
const ep = require('./easypay');
const { fetchTab, columnIndex } = require('./sheets');
const { config } = require('./config');
const payerRules = require('./payerRules');
const path = require('path');
const fsm = require('fs');

// Payments taken outside the gateway (currently Lumino's pay-by-link handful).
// Read fresh each run so adding one is a file edit, not a deploy.
function manualPayments() {
  try {
    const raw = JSON.parse(fsm.readFileSync(path.join(__dirname, '..', 'config', 'manual-payments.json'), 'utf8'));
    return Array.isArray(raw.payments) ? raw.payments : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Revenue] could not read manual-payments.json:', e.message);
    return [];
  }
}

// Fold accents before stripping punctuation, or "Márquez" loses its á and stops
// matching "Marquez" — silently, and only for the clients with accented names.
const norm = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// The cardholder name and the sheet name are typed by different people, years
// apart, and rarely agree exactly: "Rafa" vs "Rafael", "Joe" vs "Joseph",
// "Juan c solis" with a middle initial, "McPherwon" for "Mcpherson". Matching on
// the exact string left ~$1.7k of real payments unattributed, so names are
// compared as (first name, last name) with the middles dropped.
function nameParts(s) {
  const toks = norm(s).split(' ').filter(t => t.length > 1); // drops middle initials
  if (!toks.length) return null;
  if (toks.length === 1) return { first: toks[0], last: toks[0] };
  return { first: toks[0], last: toks[toks.length - 1] };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;             // caller only cares about ≤2
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Nicknames that are NOT prefixes of the full name, so no amount of string
// comparison finds them. "Joe" is not the start of "Joseph" — that is "Jos" —
// which is exactly how Joe Biedron's payments went unattributed.
const NICKNAMES = [
  ['joe', 'joseph'], ['bob', 'robert'], ['rob', 'robert'], ['bill', 'william'], ['will', 'william'],
  ['dick', 'richard'], ['rick', 'richard'], ['jack', 'john'], ['jim', 'james'], ['ted', 'edward'],
  ['ned', 'edward'], ['betty', 'elizabeth'], ['liz', 'elizabeth'], ['hank', 'henry'],
  ['harry', 'henry'], ['chuck', 'charles'], ['tony', 'anthony'], ['kate', 'katherine'],
];
const nicknameOf = (a, b) => NICKNAMES.some(([s, f]) => (a === s && b === f) || (a === f && b === s));

// A shortened first name counts ("Josh" ⊂ "Joshua", "Rafa" ⊂ "Rafael", "Mo" ⊂
// "Moe"), as does a known nickname, but two different names never do.
const firstNamesAgree = (a, b) =>
  a === b ||
  (a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a))) ||
  nicknameOf(a, b);

// Only these move money. `settle` is the later half of a sale already counted —
// counting it too would double every client's revenue.
const CREDIT_ACTIONS = new Set(['sale', 'capture', 'capture_complete']);
const DEBIT_ACTIONS = new Set(['refund', 'credit', 'chargeback']);

// campaign name → the EasyPay Reference in the sheet
async function referenceMap({ force = false } = {}) {
  const rows = await fetchTab(config.tabRoster, { force });
  const head = rows[0] || [];
  const cRef = columnIndex(head, 'EasyPay Reference', 'EasyPay Ref');
  const cName = columnIndex(head, 'Campaign');
  const out = new Map();
  if (cRef === -1 || cName === -1) return out;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const ref = String(r[cRef] || '').trim();
    const name = String(r[cName] || '').trim();
    if (ref && name) out.set(name, ref);
  }
  return out;
}

// entities come from roster.fetchEntities()
async function revenueByEntity(startDay, endDay, entities, { force = false } = {}) {
  if (!ep.configured()) {
    return { available: false, reason: 'EasyPay key not configured', byEntity: new Map() };
  }

  let rows;
  try {
    rows = await ep.listTransactions(startDay, endDay);
  } catch (e) {
    // A rejected key answers HTTP 200 with an error body; the client turns that
    // into a throw precisely so it cannot land here looking like "no payments".
    return { available: false, reason: e.message, byEntity: new Map() };
  }

  const rules = payerRules.load();
  const pending = payerRules.pendingClients(rules);
  const pendingKey = name => 'pending:' + norm(name);

  const refs = await referenceMap({ force });
  const byRef = new Map();      // reference → entity key
  const byLastName = new Map(); // last name → [{ first, key }]
  // A client who has paid but is not in the sheet yet still needs a row, or
  // their money silently disappears from the report while they are chased for it.
  for (const p of pending) {
    const np = nameParts(p.name);
    if (!np) continue;
    if (!byLastName.has(np.last)) byLastName.set(np.last, []);
    byLastName.get(np.last).push({ first: np.first, key: pendingKey(p.name) });
  }
  for (const e of entities) {
    const p = nameParts(e.name);
    if (p) {
      if (!byLastName.has(p.last)) byLastName.set(p.last, []);
      byLastName.get(p.last).push({ first: p.first, key: e.key });
    }
    for (const c of e.campaigns) {
      const ref = refs.get(c.name);
      if (ref) byRef.set(ref.toLowerCase(), e.key);
    }
  }

  // Exact last name first, then a near-miss (one or two letters out, which is a
  // typo) — but only ever when the first names agree too, so two different
  // people who happen to share a surname can never be merged.
  function matchByName(payerName) {
    const p = nameParts(payerName);
    if (!p) return null;
    const direct = matchParts(p);
    if (direct) return direct;
    // Spanish naming: "Noris Marquez Echeverria" carries both parents' surnames
    // while the sheet holds only the first. Try the middle surname as well.
    const toks = norm(payerName).split(' ').filter(t => t.length > 1);
    if (toks.length >= 3) return matchParts({ first: toks[0], last: toks[toks.length - 2] });
    return null;
  }

  function matchParts(p) {
    // On an exact surname, a first name one or two letters out is a typo rather
    // than a different person ("Leandor" for "Leandro").
    const exact = (byLastName.get(p.last) || [])
      .filter(c => firstNamesAgree(c.first, p.first) || levenshtein(c.first, p.first) <= 2);
    if (exact.length === 1) return exact[0].key;
    if (exact.length > 1) return null;                 // ambiguous: leave it unmatched
    const near = [];
    for (const [last, cands] of byLastName) {
      if (levenshtein(last, p.last) <= 2) {
        for (const c of cands) if (firstNamesAgree(c.first, p.first)) near.push(c.key);
      }
    }
    return near.length === 1 ? near[0] : null;
  }

  const byEntity = new Map();
  const add = (key, amount) => byEntity.set(key, Math.round(((byEntity.get(key) || 0) + amount) * 100) / 100);

  const stats = {
    sales: 0, salesAmount: 0, refunds: 0, refundAmount: 0,
    failed: 0, failedAmount: 0,
    viaReference: 0, viaAlias: 0, viaName: 0, viaPending: 0,
    ignored: 0, ignoredAmount: 0,
    unmatched: 0, unmatchedAmount: 0, unmatchedSample: [],
    unallocated: [],     // the report's "Unallocated payments" section
    unknownVaults: [],   // vault ids seen here but not in the rules or the sheet
    pendingUsed: [],     // pending clients who actually paid in this window
  };

  for (const t of rows) {
    const credit = CREDIT_ACTIONS.has(t.actionType);
    const debit = DEBIT_ACTIONS.has(t.actionType);
    if (!credit && !debit) continue;           // auth, void, settle: not money

    if (!t.success) {
      if (credit) { stats.failed++; stats.failedAmount += t.amount; }
      continue;
    }

    const signed = credit ? t.amount : -Math.abs(t.amount);

    // Known non-revenue: test cards, and another agency's payments on the same
    // gateway. Excluded before anything else so they never reach the report —
    // that is the whole point of the ignore list.
    const ignored = payerRules.ignoreReason(rules, t);
    if (ignored) {
      stats.ignored++; stats.ignoredAmount += signed;
      continue;
    }

    if (credit) { stats.sales++; stats.salesAmount += t.amount; }
    else { stats.refunds++; stats.refundAmount += Math.abs(t.amount); }

    const vault = String(t.vaultId || '').toLowerCase();
    const person = `${t.firstName || ''} ${t.lastName || ''}`.trim();
    const aliasName = payerRules.aliasClient(rules, vault);
    const aliasKey = aliasName ? (matchByName(aliasName) || pendingKey(aliasName)) : null;
    const nameKey = person ? matchByName(person) : null;

    if (vault && byRef.has(vault)) {
      add(byRef.get(vault), signed);
      stats.viaReference++;
    } else if (aliasKey) {
      add(aliasKey, signed);
      stats.viaAlias++;
      if (aliasKey.startsWith('pending:') && !stats.pendingUsed.includes(aliasName)) stats.pendingUsed.push(aliasName);
    } else if (nameKey) {
      add(nameKey, signed);
      if (nameKey.startsWith('pending:')) {
        stats.viaPending++;
        if (!stats.pendingUsed.includes(person)) stats.pendingUsed.push(person);
      } else {
        stats.viaName++;
      }
      // Matched by name, on a card the sheet and the rules have never seen. The
      // client is fine; the mapping is out of date, and listing it is how it
      // gets put right (scripts/learn-vaults.js turns these into aliases).
      if (vault && !stats.unknownVaults.some(u => u.vault === vault)) {
        stats.unknownVaults.push({ vault, client: person, amount: signed });
      }
    } else {
      stats.unmatched++;
      stats.unmatchedAmount += signed;
      const label = person || t.email || t.transactionId;
      if (stats.unmatchedSample.length < 10 && !stats.unmatchedSample.includes(label)) {
        stats.unmatchedSample.push(label);
      }
      stats.unallocated.push({
        date: t.at ? t.at.toISOString().slice(0, 10) : '',
        name: person, email: t.email || '', amount: signed,
        vault: t.vaultId || '', description: t.description || '',
        transactionId: t.transactionId,
      });
    }
  }
  stats.unallocated.sort((a, b) => b.amount - a.amount);

  // Payments taken outside EasyPay (Lumino), entered by hand in
  // config/manual-payments.json. Counted in Revenue like any other payment, but
  // tracked separately so the report can say how much of the total is hand-entered
  // — an unverifiable number should never be silently mixed into a gateway total.
  for (const m of manualPayments()) {
    if (!m.date || m.date < startDay || m.date > endDay) continue;
    const key = matchByName(m.client);
    if (!key) {
      stats.manualUnmatched = (stats.manualUnmatched || 0) + 1;
      stats.unallocated.push({
        date: m.date, name: m.client, email: '', amount: Number(m.amount) || 0,
        vault: '', description: `${m.source || 'manual'} — no client of this name in the sheet`,
        transactionId: 'manual',
      });
      continue;
    }
    add(key, Number(m.amount) || 0);
    stats.manual = (stats.manual || 0) + 1;
    stats.manualAmount = Math.round(((stats.manualAmount || 0) + (Number(m.amount) || 0)) * 100) / 100;
    stats.salesAmount = Math.round((stats.salesAmount + (Number(m.amount) || 0)) * 100) / 100;
  }

  stats.salesAmount = Math.round(stats.salesAmount * 100) / 100;
  stats.refundAmount = Math.round(stats.refundAmount * 100) / 100;
  stats.failedAmount = Math.round(stats.failedAmount * 100) / 100;
  stats.unmatchedAmount = Math.round(stats.unmatchedAmount * 100) / 100;

  return { available: true, reason: null, byEntity, stats, pending };
}

module.exports = { revenueByEntity, referenceMap, nameParts, firstNamesAgree, levenshtein, norm, CREDIT_ACTIONS, DEBIT_ACTIONS };
