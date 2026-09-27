// All the accounting math lives here, separate from the web layer, so it can be tested directly.
const { addDays, diffDays, min, max, monthRange } = require('./dates');

function nightsOf(b) {
  return diffDays(b.check_in, b.check_out);
}

// Nights of a stay that fall inside [from, to] (both inclusive).
function nightsInRange(b, from, to) {
  const start = max(b.check_in, from);
  const end = min(b.check_out, addDays(to, 1));
  return Math.max(0, diffDays(start, end));
}

// Accrual basis: the share of a booking's money that belongs to [from, to],
// split by nights. A same-day booking (0 nights) is recognised on its check-in date.
function accrualShare(b, from, to) {
  const total = nightsOf(b);
  if (total <= 0) return b.check_in >= from && b.check_in <= to ? 1 : 0;
  return nightsInRange(b, from, to) / total;
}

function payoutCents(b) {
  return b.gross_cents - (b.commission_deducted ? b.commission_cents : 0);
}

// Split an amount evenly into n integer parts that add back up exactly.
function splitEvenly(cents, n) {
  if (n <= 0) return [];
  const base = Math.trunc(cents / n);
  const parts = Array(n).fill(base);
  let rem = cents - base * n;
  for (let i = 0; rem !== 0; i++, rem -= Math.sign(rem)) parts[i] += Math.sign(rem);
  return parts;
}

/**
 * Profit & loss for [from, to].
 * basis 'accrual': booking revenue/commission recognised by nights stayed in the period.
 * basis 'cash': booking revenue recognised when the payout is received; separately-invoiced
 *   commissions are recognised when paid.
 * Columns are one per listing plus 'shared' (costs not tied to one unit). Shared net is then
 * allocated evenly across active listings to show each unit's true bottom line.
 */
function profitAndLoss(db, { from, to, basis = 'accrual' }) {
  const listings = db.prepare('SELECT * FROM listings ORDER BY sort_order, id').all();
  const cols = [...listings.map((l) => String(l.id)), 'shared'];
  const lines = new Map();

  const add = (key, label, section, col, amount) => {
    if (!amount) return;
    if (!lines.has(key)) lines.set(key, { key, label, section, amounts: Object.fromEntries(cols.map((c) => [c, 0])), total: 0 });
    const line = lines.get(key);
    const c = col == null ? 'shared' : String(col);
    line.amounts[c] = (line.amounts[c] || 0) + amount;
    line.total += amount;
  };

  const bookings = db.prepare('SELECT * FROM bookings WHERE check_in <= ? AND check_out >= ? OR (payout_date BETWEEN ? AND ?)').all(to, from, from, to);
  for (const b of bookings) {
    let room, cleaning, commission;
    if (basis === 'cash') {
      if (b.payout_status !== 'received' || !b.payout_date || b.payout_date < from || b.payout_date > to) continue;
      room = b.gross_cents - b.cleaning_fee_cents;
      cleaning = b.cleaning_fee_cents;
      commission = b.commission_deducted ? b.commission_cents : 0;
    } else {
      const share = accrualShare(b, from, to);
      if (!share) continue;
      room = Math.round((b.gross_cents - b.cleaning_fee_cents) * share);
      cleaning = Math.round(b.cleaning_fee_cents * share);
      commission = Math.round(b.commission_cents * share);
    }
    add('room', 'Room revenue', 'income', b.listing_id, room);
    add('cleaning', 'Cleaning fees collected', 'income', b.listing_id, cleaning);
    add('commission', 'Platform commissions', 'expense', b.listing_id, commission);
  }

  const txs = db.prepare(`
    SELECT t.*, c.name AS category_name, c.sort_order AS category_order
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.date BETWEEN ? AND ? AND t.type IN ('income','expense','commission_payment')
  `).all(from, to);
  const order = new Map();
  for (const t of txs) {
    if (t.type === 'commission_payment') {
      if (basis === 'cash') add('commission', 'Platform commissions', 'expense', t.listing_id, t.amount_cents);
      continue;
    }
    const key = `cat:${t.category_id}`;
    order.set(key, t.category_order ?? 9999);
    add(key, t.category_name || 'Uncategorised', t.type, t.listing_id, t.amount_cents);
  }

  const fixed = { room: -3, cleaning: -2, commission: -1 };
  const sorted = [...lines.values()].sort((a, b) => (fixed[a.key] ?? order.get(a.key)) - (fixed[b.key] ?? order.get(b.key)));
  const income = sorted.filter((l) => l.section === 'income');
  const expense = sorted.filter((l) => l.section === 'expense');

  const sum = (ls) => {
    const out = Object.fromEntries(cols.map((c) => [c, 0]));
    let total = 0;
    for (const l of ls) {
      for (const c of cols) out[c] += l.amounts[c];
      total += l.total;
    }
    return { amounts: out, total };
  };
  const totalIncome = sum(income);
  const totalExpense = sum(expense);
  const net = { amounts: {}, total: totalIncome.total - totalExpense.total };
  for (const c of cols) net.amounts[c] = totalIncome.amounts[c] - totalExpense.amounts[c];

  const active = listings.filter((l) => l.active);
  const parts = splitEvenly(net.amounts.shared, active.length);
  const allocated = {};
  const netAfterShared = {};
  active.forEach((l, i) => { allocated[l.id] = parts[i]; });
  for (const l of listings) {
    allocated[l.id] = allocated[l.id] || 0;
    netAfterShared[l.id] = net.amounts[String(l.id)] + allocated[l.id];
  }

  return { from, to, basis, listings, cols, income, expense, totalIncome, totalExpense, net, allocated, netAfterShared };
}

// Occupancy, ADR, RevPAR per listing for [from, to]. Always accrual (nights-based).
function kpis(db, { from, to }) {
  const listings = db.prepare('SELECT * FROM listings ORDER BY sort_order, id').all();
  const days = diffDays(from, addDays(to, 1));
  const bookings = db.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND check_in <= ? AND check_out > ?").all(to, from);
  const rows = listings.map((l) => ({ listing: l, nights: 0, available: l.active ? days : 0, roomCents: 0, stays: 0 }));
  const byId = new Map(rows.map((r) => [r.listing.id, r]));
  for (const b of bookings) {
    const r = byId.get(b.listing_id);
    if (!r) continue;
    r.nights += nightsInRange(b, from, to);
    r.roomCents += Math.round((b.gross_cents - b.cleaning_fee_cents) * accrualShare(b, from, to));
    if (b.check_in >= from && b.check_in <= to) r.stays += 1;
  }
  const finish = (r) => ({
    ...r,
    occupancy: r.available ? r.nights / r.available : 0,
    adrCents: r.nights ? Math.round(r.roomCents / r.nights) : 0,
    revparCents: r.available ? Math.round(r.roomCents / r.available) : 0,
  });
  const total = rows.reduce((a, r) => ({
    nights: a.nights + r.nights, available: a.available + r.available,
    roomCents: a.roomCents + r.roomCents, stays: a.stays + r.stays,
  }), { nights: 0, available: 0, roomCents: 0, stays: 0 });
  return { rows: rows.map(finish), total: finish(total) };
}

// Balance of every money account as of a date (inclusive).
function accountBalances(db, asOf) {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY active DESC, id').all();
  const bal = new Map(accounts.map((a) => [a.id, a.opening_date <= asOf ? a.opening_balance_cents : 0]));
  const bump = (id, cents) => { if (id != null && bal.has(id)) bal.set(id, bal.get(id) + cents); };

  for (const b of db.prepare("SELECT * FROM bookings WHERE payout_status = 'received' AND payout_date <= ?").all(asOf)) {
    bump(b.account_id, payoutCents(b));
  }
  for (const t of db.prepare('SELECT * FROM transactions WHERE date <= ?').all(asOf)) {
    switch (t.type) {
      case 'income':
      case 'owner_contribution':
        bump(t.account_id, t.amount_cents);
        break;
      case 'transfer':
        bump(t.account_id, -t.amount_cents);
        bump(t.to_account_id, t.amount_cents);
        break;
      default: // expense, commission_payment, owner_draw
        bump(t.account_id, -t.amount_cents);
    }
  }
  const rows = accounts.map((a) => ({ account: a, balanceCents: bal.get(a.id) }));
  return { rows, totalCents: rows.reduce((s, r) => s + r.balanceCents, 0) };
}

// Commissions owed to platforms that invoice separately (e.g. Booking.com).
function commissionsPayable(db) {
  return db.prepare(`
    SELECT ch.id, ch.name,
      COALESCE((SELECT SUM(commission_cents) FROM bookings b WHERE b.channel_id = ch.id AND b.commission_deducted = 0), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.channel_id = ch.id AND t.type = 'commission_payment'), 0)
      AS owed_cents
    FROM channels ch ORDER BY ch.id
  `).all().filter((r) => r.owed_cents !== 0);
}

// Payouts not yet received. Overdue = past check-out + the channel's usual payout lag.
function pendingPayouts(db, todayStr) {
  const rows = db.prepare(`
    SELECT b.*, l.name AS listing_name, ch.name AS channel_name, ch.payout_lag_days
    FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN channels ch ON ch.id = b.channel_id
    WHERE b.payout_status = 'pending' AND (b.status = 'confirmed' OR b.gross_cents > 0) AND b.check_in <= ?
    ORDER BY b.check_out
  `).all(todayStr);
  return rows.map((b) => {
    const dueDate = addDays(b.check_out, b.payout_lag_days);
    return { ...b, payoutCents: payoutCents(b), dueDate, overdue: todayStr > dueDate };
  });
}

function monthlyTrend(db, year) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, '0')}`;
    const { from, to } = monthRange(ym);
    const p = profitAndLoss(db, { from, to, basis: 'accrual' });
    const k = kpis(db, { from, to });
    months.push({ ym, income: p.totalIncome.total, expense: p.totalExpense.total, net: p.net.total, occupancy: k.total.occupancy, nights: k.total.nights, adrCents: k.total.adrCents });
  }
  return months;
}

module.exports = {
  nightsOf, nightsInRange, accrualShare, payoutCents, splitEvenly,
  profitAndLoss, kpis, accountBalances, commissionsPayable, pendingPayouts, monthlyTrend,
};
