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

// vault id → client name
function aliasClient(rules, vaultId) {
  if (!vaultId) return null;
  const hit = rules.aliases.find(a => lc(a.vault) === lc(vaultId));
  return hit ? hit.client : null;
}

function pendingClients(rules) {
  return rules.pending.map(p => ({
    name: p.name,
    industry: p.industry || 'Other',
    note: p.note || '',
  }));
}

module.exports = { load, save, ignoreReason, aliasClient, pendingClients, FILE };
