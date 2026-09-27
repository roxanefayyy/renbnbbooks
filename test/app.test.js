const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

test('end-to-end: login, record a booking and an expense, view every page', async (t) => {
  const db = openDb(':memory:');
  const server = createApp(db, { password: 'pw', secret: 's' }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = (path, { form, ...opts } = {}) => fetch(base + path, {
    redirect: 'manual',
    ...opts,
    method: form ? 'POST' : opts.method || 'GET',
    headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

  assert.equal((await req('/')).headers.get('location'), '/login');
  assert.equal((await req('/login', { form: { username: 'admin', password: 'nope' } })).status, 401);
  const login = await req('/login', { form: { username: 'admin', password: 'pw' } });
  assert.equal(login.status, 302);
  cookie = login.headers.get('set-cookie').split(';')[0];

  // Validation errors re-render the form.
  const bad = await req('/bookings', { form: { listing_id: '1', channel_id: '1', check_in: '2026-09-10', check_out: '2026-09-08', gross: 'abc' } });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Check-out must be on or after check-in/);

  const ok = await req('/bookings', { form: {
    listing_id: '1', channel_id: '1', guest_name: '<script>x</script>', check_in: '2026-09-10', check_out: '2026-09-13',
    gross: '9,000', cleaning_fee: '600', commission: '270', commission_deducted: 'on', status: 'confirmed',
    payout_status: 'received', payout_date: '2026-09-11', account_id: '1',
  } });
  assert.equal(ok.status, 302);

  const exp = await req('/transactions', { form: { type: 'expense', date: '2026-09-12', amount: '1500', account_id: '1', category_id_expense: '4', listing_id: '1', vendor: 'Raymond' } });
  assert.equal(exp.status, 302);

  const list = await (await req('/bookings?month=2026-09')).text();
  assert.ok(!list.includes('<script>x</script>'), 'guest name must be escaped');
  assert.match(list, /₱8,730\.00/);

  const pnl = await (await req('/reports/pnl?from=2026-09-01&to=2026-09-30')).text();
  assert.match(pnl, /₱8,400\.00/); // room revenue
  assert.match(pnl, /₱7,230\.00/); // net

  for (const p of ['/?month=2026-09', '/reports/trend?year=2026', '/accounts', '/settings', '/transactions?month=2026-09', '/bookings/new', '/transactions/new', '/bookings/1/edit', '/transactions/1/edit']) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
  }

  const csv = await (await req('/export/bookings.csv')).text();
  assert.match(csv, /8730\.00/);
  const pnlCsv = await req('/export/pnl.csv?from=2026-09-01&to=2026-09-30');
  assert.equal(pnlCsv.status, 200);
  const backup = await req('/export/backup.sqlite');
  assert.equal(backup.status, 200);
  assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');

  const renamed = await req('/settings/listings/1', { form: { name: 'Azure Unit 12F', address: '', sort_order: '1', active: 'on' } });
  assert.equal(renamed.status, 302);
  assert.equal(db.prepare('SELECT name FROM listings WHERE id = 1').get().name, 'Azure Unit 12F');

  // --- Hospitable import over HTTP ---
  const csvText = 'Reservation Code,Property Name,Guest Name,Platform,Status,Check-in,Check-out,Host Service Fee,Total Payout\nHM1,Azure Unit 12F,Ana,Airbnb,Accepted,09/20/2026,09/22/2026,-₱90.00,"₱2,910.00"\n';
  const up = await req('/import/upload', { form: { csv_text: csvText, filename: 'h.csv' } });
  const batchPath = up.headers.get('location').replace(/columns$/, '');
  assert.match(await (await req(batchPath + 'columns')).text(), /Reservation Code/);
  const cols = { col_external_id: '0', col_property: '1', col_guest_name: '2', col_channel: '3', col_status: '4', col_check_in: '5', col_check_out: '6', col_commission: '7', col_payout: '8', date_format: 'mdy' };
  assert.equal((await req(batchPath + 'columns', { form: cols })).headers.get('location'), batchPath + 'review');
  const review = await (await req(batchPath + 'review')).text();
  assert.match(review, /Import 1 booking</);
  const done = await req(batchPath + 'review', { form: { action: 'commit', lv_0: 'Azure Unit 12F', lm_0: '1', cv_0: 'Airbnb', cm_0: '1' } });
  assert.match(decodeURIComponent(done.headers.get('location')), /1 new/);
  assert.equal(db.prepare("SELECT gross_cents FROM bookings WHERE external_id = 'HM1'").get().gross_cents, 300000);

  // --- Rhea: encoder login ---
  const addUser = await req('/settings/users', { form: { name: 'Rhea', username: 'rhea', role: 'encoder', password: 'rhea-pass-1' } });
  assert.equal(addUser.status, 302);
  const ownerCookie = cookie;
  cookie = '';
  const rl = await req('/login', { form: { username: 'Rhea', password: 'rhea-pass-1' } });
  assert.equal(rl.headers.get('location'), '/transactions');
  cookie = rl.headers.get('set-cookie').split(';')[0];

  assert.equal((await req('/')).headers.get('location'), '/transactions');
  for (const p of ['/bookings', '/reports/pnl', '/accounts', '/settings', '/export/backup.sqlite', '/import', '/transactions/1/edit']) {
    assert.equal((await req(p)).status, 403, p);
  }
  assert.equal((await req('/settings/users', { form: { name: 'x', username: 'xx', role: 'admin', password: '12345678' } })).status, 403);

  const form = await (await req('/transactions/new')).text();
  assert.ok(!form.includes('Owner draw') && !form.includes('Transfer between'), 'encoder sees only expense/income types');
  assert.match(form, /Parking income/);
  assert.ok(!form.includes('Damage reimbursements'), 'encoder sees only allowed income categories');

  const parkingId = db.prepare("SELECT id FROM categories WHERE name = 'Parking income'").get().id;
  const otherIncomeId = db.prepare("SELECT id FROM categories WHERE name = 'Other income'").get().id;
  assert.equal((await req('/transactions', { form: { type: 'income', date: '2026-09-15', amount: '300', account_id: '3', category_id_income: String(parkingId) } })).status, 302);
  assert.equal((await req('/transactions', { form: { type: 'expense', date: '2026-09-15', amount: '250', account_id: '3', category_id_expense: '5', vendor: 'Laundry shop' } })).status, 302);
  assert.equal((await req('/transactions', { form: { type: 'income', date: '2026-09-15', amount: '999', account_id: '3', category_id_income: String(otherIncomeId) } })).status, 400);
  assert.equal((await req('/transactions', { form: { type: 'owner_draw', date: '2026-09-15', amount: '999', account_id: '3' } })).status, 400);

  const rheaList = await (await req('/transactions?month=2026-09')).text();
  assert.match(rheaList, /Raymond/, 'encoder sees all expenses');
  const mine = db.prepare("SELECT id FROM transactions WHERE vendor = 'Laundry shop'").get().id;
  assert.equal((await req(`/transactions/${mine}/edit`)).status, 200);
  assert.equal(db.prepare('SELECT u.name FROM transactions t JOIN users u ON u.id = t.created_by WHERE t.id = ?').get(mine).name, 'Rhea');

  // Deactivating Rhea logs her out immediately.
  const rheaCookie = cookie;
  cookie = ownerCookie;
  const rheaId = db.prepare("SELECT id FROM users WHERE username = 'rhea'").get().id;
  await req(`/settings/users/${rheaId}`, { form: { name: 'Rhea', username: 'rhea', role: 'encoder', password: '' } });
  cookie = rheaCookie;
  assert.equal((await req('/transactions')).headers.get('location'), '/login');
});
