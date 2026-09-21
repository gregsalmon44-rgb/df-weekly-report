# Demand Flow — Weekly Profitability Report

A branded landscape PDF of Demand Flow's profitability — all-time alongside the
week just finished, in total, by industry and by client — posted to Slack every
Monday at 8am London time.

Deliberately separate from the Outbound Experts portal: its own repo, its own
Railway service, its own data. Some code was copied from that portal's report;
nothing is shared at runtime.

## Where the numbers come from

Everything is read live at render time. There is no ingest, nothing to sync, and
nothing that can go stale between Mondays.

| Figure | Source |
|---|---|
| Leads | Master sheet, `SMS Leads` tab — one row per lead, matched on LocationID (campaign name as fallback) |
| SMS sent | `SMS Sent Out` tab today; the `sms_sends` table once the GHL webhook is live |
| Revenue | EasyPay Direct's reporting API, attributed by vault id then cardholder name |
| Revenue (Lumino) | `config/manual-payments.json`, entered by hand — Lumino has no API |
| Data cost | The Demand Flow ZIP dashboard (PhantomDash), keyed by campaign name or location id |
| Industry, status, state | Master sheet, `SMS Schedule View` tab |

Columns are found by **header name**, so inserting or reordering columns is safe.
Renaming one is not — `src/sheetHealth.js` checks for every column the report
needs and prints a warning on the report itself naming anything missing.

## What is deliberately not silent

A missing input never prints as a zero, because a zero is indistinguishable from
a genuinely quiet week and gets believed. Instead the report carries a
**Reporting notes** box naming what it could not account for: unattributed leads
or payments, an unreachable gateway, missing data cost, clients who have paid but
are not in the sheet yet, and how much revenue was entered by hand.

## Running it locally

```bash
npm install
cp .env.example .env     # then fill in the secrets
npm run preview                        # last completed week
npm run preview 2026-09-14 2026-09-20  # a specific week
```

The PDF lands in `previews/`. Nothing is posted to Slack.

## Endpoints

All but `/health` require the `x-report-secret` header (`ADMIN_SECRET`).

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /api/report.json?start=&end=` | the figures, without rendering |
| `GET /api/report.pdf?start=&end=&download=1` | the PDF |
| `POST /api/report/slack` | render and post now (body may carry `start`/`end`) |
| `GET /api/slack-check` | confirms the bot token and channel work |

## Configuration

See `.env.example`. The ones that matter:

- `EASYPAY_SECURITY_KEY` — a **private, type API** key from EasyPay
  (Settings → Security Keys). Read-only use; this service never charges anything.
- `PHANTOMDASH_URL`, `PHANTOMDASH_COST_SECRET` — data cost. Unset means the
  report says so rather than reporting zero cost.
- `DATA_COST_KEY` — `campaign` (default) or `location`. Switch to `location`
  once the dashboard has imported the sheet's LocationID column.
- `SLACK_BOT_TOKEN`, `SLACK_REPORT_CHANNEL_ID` — delivery. The bot needs
  `files:write` and `chat:write`, and must be invited to the channel: a PDF
  cannot be posted through an incoming webhook.
- `ADMIN_SECRET` — gates the routes above.
- `DATABASE_URL` — only needed by the SMS counter (not yet built).

## Judgement calls the report makes

- **Billing entities.** One client usually runs several campaigns and pays once,
  so campaigns are grouped by the client's name and reported as one row. The key
  ignores punctuation, because "Stellar Pro" and "Stellar-Pro" are one client.
- **Multiple industries.** A client trading across several industries is reported
  in its own category, with per-industry sub-lines showing leads and SMS/lead.
  The money columns there are blank on purpose: revenue arrives as one payment
  and splitting it between industries would be invented. An industry only counts
  once it has delivered a lead.
- **LeadBreakers (Cooper)** is not billed through the gateway, so his revenue is
  accrued at an agreed rate per lead — see `config/computed-revenue.json`, which
  also carries the footnote the report prints. He is broken down by state rather
  than industry.
- **Payer rules** (`config/payer-rules.json`) hold payments that are never
  revenue (test cards, another agency on the same gateway), known card ids per
  client, and clients who have paid but are not in the sheet yet.
  `node scripts/learn-vaults.js` proposes new card mappings; `--write` saves them.
