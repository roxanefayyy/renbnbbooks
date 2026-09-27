const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { parseMoney, formatMoney } = require('../src/money');
const R = require('../src/reports');

function fresh() {
  const db = openDb(':memory:');
  const ids = {
    l1: 1, l2: 2,
    airbnb: db.prepare("SELECT id FROM channels WHERE name='Airbnb'").get().id,
    booking: db.prepare("SELECT id FROM channels WHERE name='Booking.com'").get().id,
    bank: db.prepare("SELECT id FROM accounts WHERE name='Bank account'").get().id,
    gcash: db.prepare("SELECT id FROM accounts WHERE name='GCash'").get().id,
    cleaning: db.prepare("SELECT id FROM categories WHERE name='Cleaning & housekeeping'").get().id,
    internet: db.prepare("SELECT id FROM categories WHERE name='Internet'").get().id,
  };
  db.prepare("UPDATE accounts SET opening_date = '2026-01-01'").run();
  // Keep allocation maths simple: only two active listings.
  db.prepare('UPDATE listings SET active = 0 WHERE id > 2').run();
  return { db, ids };
}

function booking(db, b) {
  const row = { guest_name: 'G', guests: 1, cleaning_fee_cents: 0, commission_cents: 0, commission_deducted: 1, status: 'confirmed', payout_status: 'pending', payout_date: null, account_id: null, ...b };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
}

function tx(db, t) {
  const row = { listing_id: null, category_id: null, channel_id: null, to_account_id: null, ...t };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO transactions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
}

test('money parsing and formatting', () => {
  assert.equal(parseMoney('₱1,234.5'), 123450);
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney(''), 0);
  assert.throws(() => parseMoney('12.345'));
  assert.throws(() => parseMoney('abc'));
  assert.equal(formatMoney(123456789), '₱1,234,567.89');
  assert.equal(formatMoney(-5), '-₱0.05');
});

test('splitEvenly always adds back up', () => {
  assert.deepEqual(R.splitEvenly(100, 3), [34, 33, 33]);
  assert.deepEqual(R.splitEvenly(-100, 3), [-34, -33, -33]);
  assert.equal(R.splitEvenly(1001, 7).reduce((a, b) => a + b), 1001);
});

test('accrual splits a month-crossing stay by nights', () => {
  const { db, ids } = fresh();
  // 4 nights: Jan 30, Jan 31 | Feb 1, Feb 2.  ₱10,000 gross incl ₱1,000 cleaning, ₱300 commission.
  booking(db, { listing_id: ids.l1, channel_id: ids.airbnb, check_in: '2026-01-30', check_out: '2026-02-03', gross_cents: 1000000, cleaning_fee_cents: 100000, commission_cents: 30000 });
  const jan = R.profitAndLoss(db, { from: '2026-01-01', to: '2026-01-31' });
  const feb = R.profitAndLoss(db, { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(jan.totalIncome.total, 500000);
  assert.equal(feb.totalIncome.total, 500000);
  assert.equal(jan.expense.find((l) => l.key === 'commission').total, 15000);
  assert.equal(jan.income.find((l) => l.key === 'room').amounts['1'], 450000);
  const k = R.kpis(db, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(k.rows[0].nights, 2);
  assert.equal(k.rows[0].adrCents, 225000);
  assert.equal(k.total.available, 31 * 2);
});

test('cash basis counts revenue when payout lands; invoiced commission when paid', () => {
  const { db, ids } = fresh();
  booking(db, { listing_id: ids.l1, channel_id: ids.booking, check_in: '2026-03-10', check_out: '2026-03-12', gross_cents: 500000, commission_cents: 75000, commission_deducted: 0, payout_status: 'received', payout_date: '2026-04-02', account_id: ids.bank });
  tx(db, { date: '2026-04-20', type: 'commission_payment', amount_cents: 75000, account_id: ids.bank, channel_id: ids.booking });
  const mar = R.profitAndLoss(db, { from: '2026-03-01', to: '2026-03-31', basis: 'cash' });
  const apr = R.profitAndLoss(db, { from: '2026-04-01', to: '2026-04-30', basis: 'cash' });
  assert.equal(mar.totalIncome.total, 0);
  assert.equal(apr.totalIncome.total, 500000);
  assert.equal(apr.totalExpense.total, 75000);
  // Accrual: commission in March, the invoice payment is not a second expense.
  const marA = R.profitAndLoss(db, { from: '2026-03-01', to: '2026-03-31' });
  const aprA = R.profitAndLoss(db, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(marA.totalExpense.total, 75000);
  assert.equal(aprA.totalExpense.total, 0);
  // Payable cleared, bank got full gross then paid the invoice.
  assert.deepEqual(R.commissionsPayable(db), []);
  assert.equal(R.accountBalances(db, '2026-04-30').rows.find((r) => r.account.id === ids.bank).balanceCents, 425000);
});

test('shared expenses are allocated evenly; draws and transfers stay out of P&L', () => {
  const { db, ids } = fresh();
  booking(db, { listing_id: ids.l1, channel_id: ids.airbnb, check_in: '2026-05-01', check_out: '2026-05-03', gross_cents: 400000, commission_cents: 12000, payout_status: 'received', payout_date: '2026-05-02', account_id: ids.gcash });
  tx(db, { date: '2026-05-05', type: 'expense', amount_cents: 150000, account_id: ids.gcash, listing_id: ids.l1, category_id: ids.cleaning });
  tx(db, { date: '2026-05-06', type: 'expense', amount_cents: 200001, account_id: ids.gcash, category_id: ids.internet });
  tx(db, { date: '2026-05-07', type: 'owner_draw', amount_cents: 10000, account_id: ids.gcash });
  tx(db, { date: '2026-05-08', type: 'transfer', amount_cents: 5000, account_id: ids.gcash, to_account_id: ids.bank });
  const p = R.profitAndLoss(db, { from: '2026-05-01', to: '2026-05-31' });
  assert.equal(p.net.total, 400000 - 12000 - 150000 - 200001);
  assert.equal(p.net.amounts.shared, -200001);
  assert.equal(p.allocated[1] + p.allocated[2], -200001);
  assert.equal(p.netAfterShared[1] + p.netAfterShared[2], p.net.total);
  const bal = R.accountBalances(db, '2026-05-31');
  assert.equal(bal.rows.find((r) => r.account.id === ids.gcash).balanceCents, 388000 - 150000 - 200001 - 10000 - 5000);
  assert.equal(bal.rows.find((r) => r.account.id === ids.bank).balanceCents, 5000);
});

test('pending payouts flag overdue by channel lag', () => {
  const { db, ids } = fresh();
  booking(db, { listing_id: ids.l1, channel_id: ids.airbnb, check_in: '2026-06-01', check_out: '2026-06-03', gross_cents: 100000 });
  booking(db, { listing_id: ids.l2, channel_id: ids.booking, check_in: '2026-06-01', check_out: '2026-06-03', gross_cents: 100000 });
  booking(db, { listing_id: ids.l2, channel_id: ids.airbnb, check_in: '2026-07-01', check_out: '2026-07-03', gross_cents: 100000 });
  const p = R.pendingPayouts(db, '2026-06-10');
  assert.equal(p.length, 2);
  assert.equal(p.find((b) => b.channel_id === ids.airbnb).overdue, true);
  assert.equal(p.find((b) => b.channel_id === ids.booking).overdue, false);
});
