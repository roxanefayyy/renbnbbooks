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
  assert.equal((await req('/login', { form: { password: 'nope' } })).status, 401);
  const login = await req('/login', { form: { password: 'pw' } });
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
});
