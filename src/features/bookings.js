const express = require('express');
const { html, raw } = require('../html');
const { layout, money, options } = require('../views');
const { validator, FormErrors } = require('../forms');
const { centsToInput, parseMoney } = require('../money');
const { today, isMonth, monthRange, shiftMonth, monthLabel, diffDays } = require('../dates');
const { payoutCents } = require('../reports');

module.exports = function bookings(db) {
  const r = express.Router();

  const lookups = () => ({
    listings: db.prepare('SELECT * FROM listings ORDER BY sort_order, id').all(),
    channels: db.prepare('SELECT * FROM channels ORDER BY id').all(),
    accounts: db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all(),
  });

  r.get('/', (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
    const { from, to } = monthRange(month);
    const { listings, channels } = lookups();
    const where = ['b.check_in <= ?', 'b.check_out > ?'];
    const params = [to, from];
    if (req.query.listing) { where.push('b.listing_id = ?'); params.push(Number(req.query.listing)); }
    if (req.query.channel) { where.push('b.channel_id = ?'); params.push(Number(req.query.channel)); }
    if (req.query.payout === 'pending' || req.query.payout === 'received') { where.push('b.payout_status = ?'); params.push(req.query.payout); }
    const rows = db.prepare(`
      SELECT b.*, l.name AS listing_name, ch.name AS channel_name
      FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN channels ch ON ch.id = b.channel_id
      WHERE ${where.join(' AND ')} ORDER BY b.check_in, l.sort_order
    `).all(...params);

    const tot = rows.reduce((a, b) => ({ gross: a.gross + b.gross_cents, comm: a.comm + b.commission_cents, payout: a.payout + payoutCents(b) }), { gross: 0, comm: 0, payout: 0 });
    const q = (m) => `?month=${m}${req.query.listing ? `&listing=${req.query.listing}` : ''}${req.query.channel ? `&channel=${req.query.channel}` : ''}${req.query.payout ? `&payout=${req.query.payout}` : ''}`;

    const body = html`
      <h1>Bookings</h1>
      <p class="sub">Stays overlapping ${monthLabel(month)}. Revenue in the P&amp;L is split by night, so a stay crossing months is shared between them.</p>
      <div class="toolbar">
        <a class="btn ghost small" href="${q(shiftMonth(month, -1))}">‹ Prev</a>
        <form method="get">
          <label>Month<input type="month" name="month" value="${month}"></label>
          <label>Listing<select name="listing">${options(listings, req.query.listing, { blank: 'All' })}</select></label>
          <label>Channel<select name="channel">${options(channels, req.query.channel, { blank: 'All' })}</select></label>
          <label>Payout<select name="payout">${options([{ id: 'pending', name: 'Pending' }, { id: 'received', name: 'Received' }], req.query.payout, { blank: 'All' })}</select></label>
          <button class="ghost">Filter</button>
        </form>
        <a class="btn ghost small" href="${q(shiftMonth(month, 1))}">Next ›</a>
        <span class="spacer"></span>
        <a class="btn ghost" href="/import">Import from Hospitable</a>
        <a class="btn" href="/bookings/new">+ Add booking</a>
      </div>
      <div class="scroll"><table>
        <tr><th>Stay</th><th>Listing</th><th>Channel</th><th>Guest</th><th class="num">Nights</th><th class="num">Gross</th><th class="num">Commission</th><th class="num">Payout</th><th>Payout status</th><th></th></tr>
        ${rows.length ? rows.map((b) => html`<tr>
          <td>${b.check_in} → ${b.check_out}${b.status === 'cancelled' ? html` <span class="pill bad">Cancelled</span>` : ''}</td>
          <td>${b.listing_name}</td><td>${b.channel_name}</td>
          <td>${b.guest_name}${b.ref_code ? html`<div class="muted" style="font-size:12px">${b.ref_code}</div>` : ''}</td>
          <td class="num">${diffDays(b.check_in, b.check_out)}</td>
          <td class="num">${money(b.gross_cents)}</td>
          <td class="num">${money(b.commission_cents)}${b.commission_deducted ? '' : html`<div class="muted" style="font-size:12px">invoiced</div>`}</td>
          <td class="num">${money(payoutCents(b))}</td>
          <td>${b.payout_status === 'received' ? html`<span class="pill ok">Received ${b.payout_date}</span>` : html`<span class="pill warn">Pending</span>`}</td>
          <td><a href="/bookings/${b.id}/edit">Edit</a></td>
        </tr>`) : html`<tr><td colspan="10" class="muted">No bookings for this filter yet.</td></tr>`}
        ${rows.length ? html`<tr class="total"><td colspan="5">Total (${rows.length})</td><td class="num">${money(tot.gross)}</td><td class="num">${money(tot.comm)}</td><td class="num">${money(tot.payout)}</td><td colspan="2"></td></tr>` : ''}
      </table></div>`;
    res.send(layout({ title: 'Bookings', active: '/bookings', body, flash: res.locals.flash }));
  });

  function form(res, b, errors = []) {
    const { listings, channels, accounts } = lookups();
    const isNew = !b.id;
    const body = html`
      <h1>${isNew ? 'Add booking' : 'Edit booking'}</h1>
      <p class="sub">Enter what the guest paid (incl. cleaning fee) and the platform's cut. Payout is calculated.</p>
      ${errors.length ? html`<div class="flash err">${errors.map((e) => html`<div>${e}</div>`)}</div>` : ''}
      <form method="post" action="${isNew ? '/bookings' : `/bookings/${b.id}`}" class="stack card" id="bf">
        <label>Listing<select name="listing_id" required>${options(listings.filter((l) => l.active || l.id === b.listing_id), b.listing_id, { blank: '—' })}</select></label>
        <label>Channel<select name="channel_id" id="channel" required>${options(channels.filter((c) => c.active || c.id === b.channel_id), b.channel_id, { blank: '—' })}</select></label>
        <label>Guest name<input name="guest_name" value="${b.guest_name || ''}"></label>
        <label>Confirmation code<input name="ref_code" value="${b.ref_code || ''}"></label>
        <label>Check-in<input type="date" name="check_in" value="${b.check_in || ''}" required></label>
        <label>Check-out<input type="date" name="check_out" value="${b.check_out || ''}" required></label>
        <label>Guests<input type="number" min="1" name="guests" value="${b.guests || 1}"></label>
        <label>Status<select name="status">${options([{ id: 'confirmed', name: 'Confirmed' }, { id: 'cancelled', name: 'Cancelled' }], b.status || 'confirmed')}</select>
          <div class="hint">Cancelled with a payout? Keep the amounts; they still count as revenue.</div></label>
        <label>Gross (₱)<input name="gross" id="gross" inputmode="decimal" value="${centsToInput(b.gross_cents)}" placeholder="0.00" required>
          <div class="hint">Nightly rate × nights + cleaning fee + extras, before platform fees.</div></label>
        <label>Of which cleaning fee (₱)<input name="cleaning_fee" inputmode="decimal" value="${centsToInput(b.cleaning_fee_cents)}" placeholder="0.00"></label>
        <label>Platform commission (₱)<input name="commission" id="commission" inputmode="decimal" value="${centsToInput(b.commission_cents)}" placeholder="0.00">
          <div class="hint" id="rate-hint"></div></label>
        <label class="check"><input type="checkbox" name="commission_deducted" id="deducted" ${b.commission_deducted === 0 ? '' : raw('checked')}> Commission already deducted from payout</label>
        <label>Payout status<select name="payout_status">${options([{ id: 'pending', name: 'Pending' }, { id: 'received', name: 'Received' }], b.payout_status || 'pending')}</select></label>
        <label>Payout date<input type="date" name="payout_date" value="${b.payout_date || ''}"></label>
        <label>Paid into<select name="account_id">${options(accounts, b.account_id, { blank: '—' })}</select></label>
        <label class="full">Notes<textarea name="notes" rows="2">${b.notes || ''}</textarea></label>
        <div class="full"><strong>Expected payout: <span id="payout">—</span></strong></div>
        <div class="full"><button>Save booking</button> <a class="btn ghost" href="/bookings">Cancel</a></div>
      </form>
      ${isNew ? '' : html`<form method="post" action="/bookings/${b.id}/delete" style="margin-top:20px" onsubmit="return confirm('Delete this booking?')"><button class="danger">Delete booking</button></form>`}
      <script>
        const CH = ${raw(JSON.stringify(Object.fromEntries(channels.map((c) => [c.id, { rate: c.commission_rate, deducted: !!c.commission_deducted }]))).replace(/</g, '\\u003c'))};
        const $ = (id) => document.getElementById(id);
        const num = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;
        let touched = ${isNew ? 'false' : 'true'};
        $('commission').addEventListener('input', () => { touched = true; calc(); });
        function calc() {
          const c = CH[$('channel').value];
          if (c) $('rate-hint').textContent = 'Typical ' + c.rate + '% for this channel';
          if (c && !touched && $('gross').value) $('commission').value = (num($('gross').value) * c.rate / 100).toFixed(2);
          const p = num($('gross').value) - ($('deducted').checked ? num($('commission').value) : 0);
          $('payout').textContent = '₱' + p.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        $('channel').addEventListener('change', () => { const c = CH[$('channel').value]; if (c && !touched) $('deducted').checked = c.deducted; calc(); });
        $('gross').addEventListener('input', calc);
        $('deducted').addEventListener('change', calc);
        calc();
      </script>`;
    res.status(errors.length ? 400 : 200).send(layout({ title: isNew ? 'Add booking' : 'Edit booking', active: '/bookings', body }));
  }

  function parse(body) {
    const v = validator(body);
    const b = {
      listing_id: v.id('listing_id', 'listing', 'listings', db),
      channel_id: v.id('channel_id', 'channel', 'channels', db),
      guest_name: v.str('guest_name', { max: 120 }),
      ref_code: v.str('ref_code', { max: 60 }),
      check_in: v.date('check_in', 'Check-in'),
      check_out: v.date('check_out', 'Check-out'),
      guests: v.int('guests', 'Guests', { min: 1, fallback: 1 }),
      gross_cents: v.money('gross', 'Gross'),
      cleaning_fee_cents: v.money('cleaning_fee', 'Cleaning fee'),
      commission_cents: v.money('commission', 'Commission'),
      commission_deducted: v.bool('commission_deducted'),
      status: v.oneOf('status', 'Status', ['confirmed', 'cancelled']),
      payout_status: v.oneOf('payout_status', 'Payout status', ['pending', 'received']),
      payout_date: v.date('payout_date', 'Payout date', { optional: true }),
      account_id: v.id('account_id', 'account', 'accounts', db, { optional: true }),
      notes: v.str('notes', { max: 2000 }),
    };
    if (b.check_in && b.check_out && b.check_out < b.check_in) v.errors.push('Check-out must be on or after check-in.');
    if (b.cleaning_fee_cents > b.gross_cents) v.errors.push('Cleaning fee cannot exceed the gross amount.');
    if (b.commission_cents > b.gross_cents) v.errors.push('Commission cannot exceed the gross amount.');
    if (b.payout_status === 'received' && !b.payout_date) v.errors.push('Add the payout date for a received payout.');
    if (b.payout_status === 'received' && !b.account_id) v.errors.push('Pick which account the payout went into.');
    v.check();
    return b;
  }

  const COLS = ['listing_id', 'channel_id', 'guest_name', 'ref_code', 'check_in', 'check_out', 'guests', 'gross_cents', 'cleaning_fee_cents', 'commission_cents', 'commission_deducted', 'status', 'payout_status', 'payout_date', 'account_id', 'notes'];

  r.get('/new', (req, res) => form(res, { payout_status: 'pending', status: 'confirmed' }));

  r.post('/', (req, res) => {
    try {
      const b = parse(req.body);
      db.prepare(`INSERT INTO bookings (${COLS.join(',')}, created_by) VALUES (${COLS.map(() => '?').join(',')}, ?)`).run(...COLS.map((c) => b[c]), res.locals.user.id || null);
      res.redirect(`/bookings?month=${b.check_in.slice(0, 7)}&msg=Booking+saved`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      form(res, formEcho(req.body), e.messages);
    }
  });

  r.get('/:id/edit', (req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!b) return res.status(404).send(layout({ title: 'Not found', body: html`<p>Booking not found.</p>` }));
    form(res, b);
  });

  r.post('/:id', (req, res) => {
    const id = Number(req.params.id);
    try {
      const b = parse(req.body);
      db.prepare(`UPDATE bookings SET ${COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...COLS.map((c) => b[c]), id);
      res.redirect(`/bookings?month=${b.check_in.slice(0, 7)}&msg=Booking+updated`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      form(res, { ...formEcho(req.body), id }, e.messages);
    }
  });

  r.post('/:id/delete', (req, res) => {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(Number(req.params.id));
    res.redirect('/bookings?msg=Booking+deleted');
  });

  // One-click "payout landed" from the dashboard.
  r.post('/:id/received', (req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!b) return res.redirect('/');
    const account = b.account_id || db.prepare('SELECT id FROM accounts WHERE active = 1 ORDER BY id').get()?.id;
    db.prepare("UPDATE bookings SET payout_status = 'received', payout_date = ?, account_id = ?, updated_at = datetime('now') WHERE id = ?").run(today(), account ?? null, id);
    res.redirect('/?msg=Payout+marked+received');
  });

  return r;
};

// Re-populate the form from submitted values after a validation error.
function formEcho(body) {
  const safe = (s) => { try { return parseMoney(s); } catch { return 0; } };
  return {
    ...body,
    listing_id: Number(body.listing_id) || null,
    channel_id: Number(body.channel_id) || null,
    account_id: Number(body.account_id) || null,
    gross_cents: safe(body.gross),
    cleaning_fee_cents: safe(body.cleaning_fee),
    commission_cents: safe(body.commission),
    commission_deducted: body.commission_deducted === 'on' ? 1 : 0,
  };
}
