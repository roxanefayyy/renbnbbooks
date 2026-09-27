# RenBNB Books

Bookkeeping web app for RenBNB's short-term rental listings. Tracks bookings from every channel (Airbnb, Booking.com, Agoda, direct, and others), expenses, cash accounts, and per-listing profit. All amounts are in ₱.

## What it does

- **Bookings**: one row per stay, covering gross, cleaning fee, platform commission, payout, and payout status. Commission is prefilled from each channel's typical rate.
- **Money in/out**: expenses, other income, transfers between accounts, commission invoice payments, and owner draws and contributions.
- **Dashboard**: month revenue, expenses, net profit, occupancy, ADR (average daily rate), and cash on hand. It also shows each listing's net after shared costs, pending and overdue payouts, and red flags.
- **P&L**: any date range, per listing, on an accrual or cash basis. Downloadable as a CSV file.
- **Trend**: 12 months side by side.
- **Accounts**: running balances for the bank, GCash, and cash. Check these against the real apps monthly.
- **Settings**: listings, accounts, channels, and categories. Also has CSV exports and a full database backup.

## Accounting rules (so the numbers are explainable)

| Rule | Why |
|---|---|
| **Accrual** (the default) splits a booking's revenue and commission by nights stayed in each period. A stay from Jan 30 to Feb 3 is counted half in January and half in February. | This is the true monthly performance, and it's how occupancy and ADR work. |
| **Cash** counts booking revenue on the payout date. Commissions that are invoiced separately are counted when you pay the invoice. | Matches what actually hit the bank. |
| Commission marked **deducted** (Airbnb, Agoda): payout = gross − commission. **Not deducted** (Booking.com): payout = gross, and the commission is tracked as owed until you record a *Commission invoice payment*. | Stops commission being counted twice or missed. |
| An expense with no listing is **Shared**. Shared net is split evenly across active listings. | Shows whether each unit truly makes money. |
| Transfers and owner draws or contributions **never** hit the P&L. They only move cash. | Keeps personal and venture money moves out of RenBNB's profit. |
| Money is stored as whole centavos, and "today" is Manila time. | No rounding drift or timezone date slips. |

Nothing is deleted from settings. Listings, accounts, and categories are archived instead, so history stays intact.

## Run it locally

Requires Node 22.13 or later.

```bash
npm install
APP_PASSWORD=choose-a-strong-one SESSION_SECRET=$(openssl rand -hex 32) npm start
# open http://localhost:3000
```

| Env var | Purpose |
|---|---|
| `APP_PASSWORD` | Team password. **Always set this in production.** Without it the app is open to anyone. |
| `SESSION_SECRET` | Signs login cookies. Set it so logins survive restarts. |
| `DB_PATH` | SQLite file location. The default is `data/renbnb.sqlite`. |
| `PORT` | The default is 3000. |
| `TRUST_PROXY` | Set to `true` when running behind a hosting proxy, so login lockout and secure cookies work. |

## Hosting

Everything is stored in one SQLite file, so the host needs a **persistent disk**. Good options:

- **Railway** or **Render**: add a volume or disk, mount it at `/data`, and set `DB_PATH=/data/renbnb.sqlite`.
- **Fly.io**: add a volume mounted at `/data`.
- A small VPS (DigitalOcean, Hetzner) running `npm start` behind Caddy or nginx.

Serverless hosts with no disk (Vercel, Netlify) **will lose data**, so don't use them.

**Backups:** Settings → *Full database backup* downloads a copy of everything. Do this weekly and keep it in Google Drive.

## First-time setup (about 20 minutes)

1. Settings → rename *Listing 1–7* to your real units.
2. Settings → Money accounts: add your real accounts (e.g. BPI, GCash, Maya). Set each **opening balance** to the real balance on your start date.
3. Settings → Booking channels: check the commission % and payout lag against your actual statements.
4. Enter bookings from your start date onward, then expenses.

## Weekly routine (suggested)

- **Rhea / Winnand:** log every new booking and every expense with a receipt link. Hit *Mark received* when a payout lands.
- **Roxanne:** 10 minutes on the Dashboard. Clear the red flags and check that the account balances match your bank and GCash apps.
- **Month end:** download the P&L CSV and a backup.

## Development

```bash
npm run dev   # auto-restart on change
npm test      # accounting maths + end-to-end HTTP test
```

Code map: `src/reports.js` has all the accounting math (pure and tested). `src/features/*` holds one file per page group. `src/db.js` holds the schema and seed data. There is no front-end build step.
