const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Typical commission as a percent of gross, used to prefill the booking form.
  commission_rate REAL NOT NULL DEFAULT 0,
  -- 1 = platform deducts commission from the payout (Airbnb, Agoda);
  -- 0 = platform invoices commission separately (Booking.com).
  commission_deducted INTEGER NOT NULL DEFAULT 1,
  -- Days after check-out by which the payout should have landed; later = overdue.
  payout_lag_days INTEGER NOT NULL DEFAULT 7,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank','ewallet','cash','other')),
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  grp TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  guest_name TEXT NOT NULL DEFAULT '',
  ref_code TEXT NOT NULL DEFAULT '',
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  -- What the guest paid for the stay, including the cleaning fee.
  gross_cents INTEGER NOT NULL DEFAULT 0,
  cleaning_fee_cents INTEGER NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  commission_deducted INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  payout_status TEXT NOT NULL DEFAULT 'pending' CHECK (payout_status IN ('pending','received')),
  payout_date TEXT,
  account_id INTEGER REFERENCES accounts(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookings_dates ON bookings(check_in, check_out);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('expense','income','transfer','commission_payment','owner_draw','owner_contribution')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER REFERENCES accounts(id),
  listing_id INTEGER REFERENCES listings(id),
  category_id INTEGER REFERENCES categories(id),
  channel_id INTEGER REFERENCES channels(id),
  vendor TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  receipt_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date);
`;

const SEED_CHANNELS = [
  ['Airbnb', 3, 1, 1],
  ['Booking.com', 15, 0, 30],
  ['Agoda', 15, 1, 30],
  ['Direct', 0, 1, 0],
  ['Other', 0, 1, 14],
];

const SEED_CATEGORIES = [
  ['income', 'Other income', [
    'Extra services (early check-in, late check-out, tours)',
    'Damage reimbursements',
    'Other income',
  ]],
  ['expense', 'Operations', [
    'Cleaning & housekeeping',
    'Laundry & linens',
    'Guest supplies & amenities',
    'Repairs & maintenance',
  ]],
  ['expense', 'Utilities', ['Electricity', 'Water', 'Internet', 'Streaming & cable']],
  ['expense', 'Property', ['Rent / lease', 'Condo association dues', 'Loan interest', 'Insurance']],
  ['expense', 'People', ['Salaries & wages', 'Contractor fees']],
  ['expense', 'Admin', [
    'Software & subscriptions',
    'Marketing & photography',
    'Bank & payment fees',
    'Taxes, permits & licenses',
    'Professional fees',
    'Transportation',
    'Small furniture & appliances',
    'Miscellaneous',
  ]],
];

function seed(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM channels').get();
  if (n > 0) return;
  db.exec('BEGIN');
  try {
    const ch = db.prepare('INSERT INTO channels (name, commission_rate, commission_deducted, payout_lag_days) VALUES (?,?,?,?)');
    for (const c of SEED_CHANNELS) ch.run(...c);

    const cat = db.prepare('INSERT INTO categories (name, kind, grp, sort_order) VALUES (?,?,?,?)');
    let order = 0;
    for (const [kind, grp, names] of SEED_CATEGORIES) {
      for (const name of names) cat.run(name, kind, grp, order++);
    }

    const lst = db.prepare('INSERT INTO listings (name, sort_order) VALUES (?,?)');
    for (let i = 1; i <= 7; i++) lst.run(`Listing ${i}`, i);

    const acct = db.prepare("INSERT INTO accounts (name, kind, opening_date) VALUES (?,?,date('now'))");
    acct.run('Bank account', 'bank');
    acct.run('GCash', 'ewallet');
    acct.run('Cash on hand', 'cash');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Schema changes after the first release. Each entry runs once, in order; the
// database remembers how far it got in PRAGMA user_version.
const MIGRATIONS = [
  // 1: team logins, who-entered-what, Hospitable import, Rhea's parking income.
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','encoder')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  ALTER TABLE transactions ADD COLUMN created_by INTEGER REFERENCES users(id);
  ALTER TABLE bookings ADD COLUMN created_by INTEGER REFERENCES users(id);
  ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  ALTER TABLE bookings ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX bookings_external ON bookings(source, external_id) WHERE external_id IS NOT NULL;
  -- 1 = encoders (e.g. Rhea) may record income in this category. Expenses are always allowed.
  ALTER TABLE categories ADD COLUMN encoder_ok INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL DEFAULT '',
    csv_text TEXT NOT NULL,
    -- JSON: chosen columns, date format, property→listing and platform→channel choices.
    mapping TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO categories (name, kind, grp, sort_order, encoder_ok) VALUES ('Parking income', 'income', 'Other income', -1, 1);
  `,
];

function migrate(db) {
  let { user_version: v } = db.prepare('PRAGMA user_version').get();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function openDb(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'renbnb.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db);
  migrate(db);
  db.file = file;
  return db;
}

module.exports = { openDb };
