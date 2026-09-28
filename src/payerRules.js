// Who a payment belongs to, when the sheet cannot say.
//
// Three lists, all in config/payer-rules.json so they can be edited without
// touching code:
//
//   ignore   — payments that are never Demand Flow revenue (test cards, another
//              agency's payments on the same gateway). Excluded from revenue AND
//              from the unallocated list, so the report stops asking about them.
//   aliases  — vault id → client. A client may hold several cards, and a new one
//              appears whenever they re-enter their details, so this grows over
//              time. `scripts/learn-vaults.js` proposes new entries.
//   pending  — a real client who has paid but is not in the master sheet yet
//              (someone who signed up at the weekend). Their revenue is counted
//              and the report says they still need adding.
//
// Everything here is DATA, reviewed by a person. Nothing is matched silently on
// a guess: a payment that fits none of these lands in "Unallocated payments"
// where somebody can see it.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'payer-rules.json');

const EMPTY = { ignore: [], aliases: [], pending: [] };

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      ignore: Array.isArray(raw.ignore) ? raw.ignore : [],
      aliases: Array.isArray(raw.aliases) ? raw.aliases : [],
      pending: Array.isArray(raw.pending) ? raw.pending : [],
    };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[PayerRules] could not read the rules file:', e.message);
    return { ...EMPTY };
  }
}

function save(rules) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rules, null, 2) + '\n');
  return FILE;
}

const lc = s => String(s || '').trim().toLowerCase();

// Does this payment match one of the ignore entries? An entry may match on
// email, on vault id, or on the cardholder name — whichever is stable.
function ignoreReason(rules, payment) {
  for (const rule of rules.ignore) {
    if (rule.email && lc(rule.email) === lc(payment.email)) return rule.reason || 'ignored';
    if (rule.vault && lc(rule.vault) === lc(payment.vaultId)) return rule.reason || 'ignored';
    if (rule.name) {
      const full = lc(`${payment.firstName || ''} ${payment.lastName || ''}`);
      if (lc(rule.name) === full) return rule.reason || 'ignored';
    }
  }
  return null;
}

// payment → client name.
//
// Keyed on whichever identifier is stable, in order of how much it proves: a
// saved card's vault id, then the email, then the cardholder name. Email and
// name matter because a one-off payment carries NO vault id at all — a $560
// reattempt from ryan@stellar-pro.com had an empty vault and so could not be
// mapped while this only looked at vault ids.
//
// The passes are separate rather than one loop so precedence comes from the
// identifier, not from where someone happened to add the entry in the file.
function aliasClient(rules, payment) {
  const p = payment || {};
  const vault = lc(p.vaultId || p.vault);
  const email = lc(p.email);
  const name = lc(`${p.firstName || ''} ${p.lastName || ''}`);

  if (vault) {
    const hit = rules.aliases.find(a => a.vault && lc(a.vault) === vault);
    if (hit) return hit.client;
  }
  if (email) {
    const hit = rules.aliases.find(a => a.email && lc(a.email) === email);
    if (hit) return hit.client;
  }
  if (name) {
    const hit = rules.aliases.find(a => a.name && lc(a.name) === name);
    if (hit) return hit.client;
  }
  return null;
}

function pendingClients(rules) {
  return rules.pending.map(p => ({
    name: p.name,
    industry: p.industry || 'Other',
    note: p.note || '',
  }));
}

module.exports = { load, save, ignoreReason, aliasClient, pendingClients, FILE };
