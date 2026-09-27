const express = require('express');
const { html, raw } = require('../html');
const { layout, money, options } = require('../views');
const { validator, FormErrors } = require('../forms');
const { centsToInput, parseMoney } = require('../money');
const { today, isMonth, monthRange, shiftMonth, monthLabel } = require('../dates');

const TYPES = [
  { id: 'expense', name: 'Expense', hint: 'Money spent running the rentals.' },
  { id: 'income', name: 'Other income', hint: 'Income not tied to a booking payout (extra services, damage reimbursements).' },
  { id: 'commission_payment', name: 'Commission invoice payment', hint: 'Paying a platform that bills commission separately (e.g. Booking.com). Settles what you owe, not a new expense.' },
  { id: 'transfer', name: 'Transfer between accounts', hint: 'e.g. GCash → Bank. Not income or expense.' },
  { id: 'owner_draw', name: 'Owner draw', hint: 'Money you take out for yourself or another venture. Not an expense.' },
  { id: 'owner_contribution', name: 'Owner contribution', hint: 'Money you put into RenBNB from outside. Not income.' },
];
const TYPE_NAME = Object.fromEntries(TYPES.map((t) => [t.id, t.name]));

// Encoders (e.g. Rhea) record expenses, plus income only in categories marked
// "encoder can use" (Parking income). They can edit or delete only their own entries.
const isAdmin = (user) => user.role === 'admin';
const typesFor = (user) => (isAdmin(user) ? TYPES : TYPES.filter((t) => t.id === 'expense' || t.id === 'income'));
const ENCODER_VISIBLE = "(t.type = 'expense' OR (t.type = 'income' AND c.encoder_ok = 1))";

module.exports = function transactions(db) {
  const r = express.Router();

  const lookups = () => ({
    listings: db.prepare('SELECT * FROM listings ORDER BY sort_order, id').all(),
    accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY kind, sort_order, id').all(),
    channels: db.prepare('SELECT * FROM channels ORDER BY id').all(),
  });

  const canEdit = (user, t) => isAdmin(user) || (t.created_by === user.id && (t.type === 'expense'
    || (t.type === 'income' && db.prepare('SELECT encoder_ok FROM categories WHERE id = ?').get(t.category_id)?.encoder_ok === 1)));

  r.get('/', (req, res) => {
    const user = res.locals.user;
    const month = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const { from, to } = monthRange(month);
    const { listings, categories } = lookups();
    const where = ['t.date BETWEEN ? AND ?'];
    if (!isAdmin(user)) where.push(ENCODER_VISIBLE);
    const params = [from, to];
    if (req.query.type && TYPE_NAME[req.query.type]) { where.push('t.type = ?'); params.push(req.query.type); }
    if (req.query.listing === 'shared') where.push('t.listing_id IS NULL');
    else if (req.query.listing) { where.push('t.listing_id = ?'); params.push(Number(req.query.listing)); }
    if (req.query.category) { where.push('t.category_id = ?'); params.push(Number(req.query.category)); }
    const rows = db.prepare(`
      SELECT t.*, l.name AS listing_name, c.name AS category_name, a.name AS account_name, a2.name AS to_account_name, ch.name AS channel_name, u.name AS created_by_name
      FROM transactions t LEFT JOIN users u ON u.id = t.created_by
      LEFT JOIN listings l ON l.id = t.listing_id LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts a2 ON a2.id = t.to_account_id
      LEFT JOIN channels ch ON ch.id = t.channel_id
      WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC
    `).all(...params);

    const sums = {};
    for (const t of rows) sums[t.type] = (sums[t.type] || 0) + t.amount_cents;
    const q = (m) => `?month=${m}${['type', 'listing', 'category'].map((k) => (req.query[k] ? `&${k}=${encodeURIComponent(req.query[k])}` : '')).join('')}`;

    const body = html`
      <h1>Money in / out</h1>
      <p class="sub">${isAdmin(user) ? 'Expenses, other income, transfers and owner draws' : 'Expenses and parking income'} for ${monthLabel(month)}.${isAdmin(user) ? ' Booking payouts live under Bookings.' : ''}</p>
      <div class="toolbar">
        <a class="btn ghost small" href="${q(shiftMonth(month, -1))}">‹ Prev</a>
        <form method="get">
          <label>Month<input type="month" name="month" value="${month}"></label>
          <label>Type<select name="type">${options(typesFor(user), req.query.type, { blank: 'All' })}</select></label>
          <label>Listing<select name="listing"><option value="">All</option><option value="shared" ${req.query.listing === 'shared' ? 'selected' : ''}>Shared only</option>${options(listings, req.query.listing)}</select></label>
          <label>Category<select name="category">${options(isAdmin(user) ? categories : categories.filter((c) => c.kind === 'expense' || c.encoder_ok), req.query.category, { blank: 'All' })}</select></label>
          <button class="ghost">Filter</button>
        </form>
        <a class="btn ghost small" href="${q(shiftMonth(month, 1))}">Next ›</a>
        <span class="spacer"></span>
        <a class="btn" href="/transactions/new">+ Add entry</a>
      </div>
      ${Object.keys(sums).length ? html`<div class="grid" style="margin-bottom:14px">${TYPES.filter((t) => sums[t.id]).map((t) => html`<div class="card stat"><div class="label">${t.name}</div><div class="value">${money(sums[t.id])}</div></div>`)}</div>` : ''}
      <div class="scroll"><table>
        <tr><th>Date</th><th>Type</th><th>Category / detail</th><th>Listing</th><th>Account</th><th>Vendor / note</th><th>Entered by</th><th class="num">Amount</th><th></th></tr>
        ${rows.length ? rows.map((t) => html`<tr>
          <td>${t.date}</td>
          <td>${TYPE_NAME[t.type]}</td>
          <td>${t.type === 'transfer' ? `→ ${t.to_account_name}` : t.type === 'commission_payment' ? t.channel_name : t.category_name || ''}</td>
          <td>${t.listing_name || html`<span class="muted">Shared</span>`}</td>
          <td>${t.account_name}</td>
          <td>${t.vendor}${t.description ? html`<div class="muted" style="font-size:12px;white-space:normal;max-width:320px">${t.description}</div>` : ''}${t.receipt_url ? html` <a href="${t.receipt_url}" target="_blank" rel="noopener">receipt</a>` : ''}</td>
          <td class="muted">${t.created_by_name || (t.created_by === null ? 'Owner' : '')}</td>
          <td class="num">${money(['expense', 'owner_draw', 'commission_payment'].includes(t.type) ? -t.amount_cents : t.amount_cents)}</td>
          <td>${canEdit(user, t) ? html`<a href="/transactions/${t.id}/edit">Edit</a>` : ''}</td>
        </tr>`) : html`<tr><td colspan="9" class="muted">Nothing recorded for this filter yet.</td></tr>`}
      </table></div>`;
    res.send(layout({ title: 'Money in/out', active: '/transactions', body, flash: res.locals.flash }));
  });

  function form(res, t, errors = []) {
    const user = res.locals.user;
    const { listings, accounts, categories, channels } = lookups();
    const isNew = !t.id;
    const type = t.type || 'expense';
    const catOpts = (kind) => categories.filter((c) => c.kind === kind && (c.active || c.id === t.category_id) && (kind === 'expense' || isAdmin(user) || c.encoder_ok));
    // One allowed income category (Rhea's Parking income): preselect it.
    const incomeCats = catOpts('income');
    const types = typesFor(user).map((x) => (!isAdmin(user) && x.id === 'income' ? { ...x, name: 'Income (parking)', hint: 'Parking fees collected from guests or others.' } : x));
    const incomeSel = t.category_id ?? (incomeCats.length === 1 ? incomeCats[0].id : null);
    const body = html`
      <h1>${isNew ? 'Add entry' : 'Edit entry'}</h1>
      <p class="sub" id="type-hint"></p>
      ${errors.length ? html`<div class="flash err">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
      <form method="post" action="${isNew ? '/transactions' : `/transactions/${t.id}`}" class="stack card">
        <label>Type<select name="type" id="type">${options(types, type)}</select></label>
        <label>Date<input type="date" name="date" value="${t.date || today()}" required></label>
        <label>Amount (₱)<input name="amount" inputmode="decimal" value="${centsToInput(t.amount_cents)}" placeholder="0.00" required></label>
        <label><span data-label-account>From account</span><select name="account_id" required>${options(accounts.filter((a) => a.active || a.id === t.account_id), t.account_id, { blank: '—' })}</select></label>
        <label data-for="transfer">To account<select name="to_account_id">${options(accounts.filter((a) => a.active || a.id === t.to_account_id), t.to_account_id, { blank: '—' })}</select></label>
        <label data-for="expense">Category<select name="category_id_expense">${options(catOpts('expense'), t.category_id, { blank: '—', label: 'name' })}</select></label>
        <label data-for="income">Category<select name="category_id_income">${options(incomeCats, incomeSel, { blank: '—' })}</select></label>
        <label data-for="commission_payment">Platform<select name="channel_id">${options(channels, t.channel_id, { blank: '—' })}</select></label>
        <label data-for="expense income commission_payment">Listing<select name="listing_id">${options(listings.filter((l) => l.active || l.id === t.listing_id), t.listing_id, { blank: 'Shared / all listings' })}</select>
          <div class="hint">Shared costs are split evenly across active listings in the P&amp;L.</div></label>
        <label>Vendor / payee<input name="vendor" value="${t.vendor || ''}"></label>
        <label class="full">Description<input name="description" value="${t.description || ''}"></label>
        <label class="full">Receipt link<input type="url" name="receipt_url" value="${t.receipt_url || ''}" placeholder="Google Drive link to the receipt photo">
          <div class="hint">Keep receipts for BIR. Snap a photo, drop it in Drive, paste the link.</div></label>
        <div class="full"><button>Save</button> <a class="btn ghost" href="/transactions">Cancel</a></div>
      </form>
      ${isNew ? '' : html`<form method="post" action="/transactions/${t.id}/delete" style="margin-top:20px" onsubmit="return confirm('Delete this entry?')"><button class="danger">Delete entry</button></form>`}
      <script>
        const HINTS = ${raw(JSON.stringify(Object.fromEntries(types.map((x) => [x.id, x.hint]))).replace(/</g, '\\u003c'))};
        const typeSel = document.getElementById('type');
        function sync() {
          const t = typeSel.value;
          document.querySelectorAll('[data-for]').forEach((el) => { el.style.display = el.dataset.for.split(' ').includes(t) ? '' : 'none'; });
          document.querySelector('[data-label-account]').textContent = ['income', 'owner_contribution'].includes(t) ? 'Into account' : 'From account';
          document.getElementById('type-hint').textContent = HINTS[t];
        }
        typeSel.addEventListener('change', sync); sync();
      </script>`;
    res.status(errors.length ? 400 : 200).send(layout({ title: isNew ? 'Add entry' : 'Edit entry', active: '/transactions', body }));
  }

  function parse(body, user) {
    const v = validator(body);
    const type = v.oneOf('type', 'Type', typesFor(user).map((x) => x.id));
    const t = {
      type,
      date: v.date('date', 'Date'),
      amount_cents: v.money('amount', 'Amount', { positive: true }),
      account_id: v.id('account_id', 'account', 'accounts', db),
      to_account_id: null,
      listing_id: null,
      category_id: null,
      channel_id: null,
      vendor: v.str('vendor', { max: 120 }),
      description: v.str('description', { max: 500 }),
      receipt_url: v.str('receipt_url', { max: 1000 }),
    };
    if (t.receipt_url && !/^https?:\/\//i.test(t.receipt_url)) v.errors.push('Receipt link must start with http:// or https://');
    if (type === 'transfer') {
      t.to_account_id = v.id('to_account_id', 'destination account', 'accounts', db);
      if (t.to_account_id && t.to_account_id === t.account_id) v.errors.push('Transfer needs two different accounts.');
    }
    if (type === 'expense' || type === 'income') {
      const field = `category_id_${type}`;
      t.category_id = v.id(field, 'category', 'categories', db);
      const cat = t.category_id && db.prepare('SELECT kind, encoder_ok FROM categories WHERE id = ?').get(t.category_id);
      if (cat && cat.kind !== type) v.errors.push('Category does not match the entry type.');
      if (cat && type === 'income' && !isAdmin(user) && !cat.encoder_ok) v.errors.push('Your login can only record income in the allowed categories (e.g. Parking income).');
    }
    if (type === 'commission_payment') t.channel_id = v.id('channel_id', 'platform', 'channels', db);
    if (['expense', 'income', 'commission_payment'].includes(type)) t.listing_id = v.id('listing_id', 'listing', 'listings', db, { optional: true });
    v.check();
    return t;
  }

  const COLS = ['type', 'date', 'amount_cents', 'account_id', 'to_account_id', 'listing_id', 'category_id', 'channel_id', 'vendor', 'description', 'receipt_url'];

  function echo(body) {
    let amount = 0;
    try { amount = parseMoney(body.amount); } catch { /* shown as error */ }
    return {
      ...body,
      amount_cents: amount,
      account_id: Number(body.account_id) || null,
      to_account_id: Number(body.to_account_id) || null,
      listing_id: Number(body.listing_id) || null,
      channel_id: Number(body.channel_id) || null,
      category_id: Number(body[`category_id_${body.type}`]) || null,
    };
  }

  r.get('/new', (req, res) => {
    const allowedTypes = typesFor(res.locals.user).map((x) => x.id);
    form(res, { type: allowedTypes.includes(req.query.type) ? req.query.type : 'expense' });
  });

  r.post('/', (req, res) => {
    try {
      const t = parse(req.body, res.locals.user);
      t.created_by = res.locals.user.id || null; // 0 = owner env login, not a users row
      db.prepare(`INSERT INTO transactions (${COLS.join(',')}, created_by) VALUES (${COLS.map(() => '?').join(',')}, ?)`).run(...COLS.map((c) => t[c]), t.created_by);
      res.redirect(`/transactions?month=${t.date.slice(0, 7)}&msg=Saved`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      form(res, echo(req.body), e.messages);
    }
  });

  // Loads an entry the current user may change, or answers 404/403 and returns null.
  function editable(req, res) {
    const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(req.params.id));
    if (!t) { res.status(404).send(layout({ title: 'Not found', body: html`<p>Entry not found.</p>` })); return null; }
    if (!canEdit(res.locals.user, t)) { res.status(403).send(layout({ title: 'No access', body: html`<h1>No access</h1><p>You can only change entries you recorded yourself.</p>` })); return null; }
    return t;
  }

  r.get('/:id/edit', (req, res) => {
    const t = editable(req, res);
    if (t) form(res, t);
  });

  r.post('/:id', (req, res) => {
    if (!editable(req, res)) return;
    const id = Number(req.params.id);
    try {
      const t = parse(req.body, res.locals.user);
      db.prepare(`UPDATE transactions SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...COLS.map((c) => t[c]), id);
      res.redirect(`/transactions?month=${t.date.slice(0, 7)}&msg=Updated`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      form(res, { ...echo(req.body), id }, e.messages);
    }
  });

  r.post('/:id/delete', (req, res) => {
    if (!editable(req, res)) return;
    db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(req.params.id));
    res.redirect('/transactions?msg=Deleted');
  });

  return r;
};

module.exports.TYPES = TYPES;
