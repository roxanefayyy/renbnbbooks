const express = require('express');
const { html } = require('../html');
const { layout, money, pct, options } = require('../views');
const { formatMoney } = require('../money');
const { today, isMonth, isDate, monthRange, shiftMonth, monthLabel } = require('../dates');
const R = require('../reports');

module.exports = function reports(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const now = today();
    const month = isMonth(req.query.month) ? req.query.month : now.slice(0, 7);
    const { from, to } = monthRange(month);
    const prev = monthRange(shiftMonth(month, -1));
    const p = R.profitAndLoss(db, { from, to });
    const pp = R.profitAndLoss(db, prev);
    const k = R.kpis(db, { from, to });
    const bal = R.accountBalances(db, now);
    const pending = R.pendingPayouts(db, now);
    const owed = R.commissionsPayable(db);
    const overdue = pending.filter((b) => b.overdue);
    const margin = p.totalIncome.total ? p.net.total / p.totalIncome.total : 0;

    // Flags worth acting on.
    const flags = [];
    if (overdue.length) flags.push({ bad: true, text: `${overdue.length} payout(s) overdue, totalling ${formatMoney(overdue.reduce((s, b) => s + b.payoutCents, 0))}. Chase them.` });
    for (const row of k.rows) {
      // Only judge completed months; the current month is still filling up.
      if (row.listing.active && month < now.slice(0, 7) && row.occupancy < 0.4) {
        flags.push({ text: `${row.listing.name}: ${pct(row.occupancy)} occupancy in ${monthLabel(month)}.` });
      }
    }
    const lossListings = p.listings.filter((l) => l.active && p.netAfterShared[l.id] < 0);
    if (lossListings.length) flags.push({ bad: true, text: `Losing money after shared costs: ${lossListings.map((l) => l.name).join(', ')}.` });
    for (const b of bal.rows) if (b.account.active && b.balanceCents < 0) flags.push({ bad: true, text: `${b.account.name} balance is negative. A payout or expense is probably mis-recorded.` });

    const delta = (a, b) => (b ? html`<div class="note">${a >= b ? '▲' : '▼'} vs ${formatMoney(b)} last month</div>` : '');

    const body = html`
      <div class="toolbar">
        <div><h1>${monthLabel(month)}</h1><p class="sub" style="margin:0">Accrual basis · revenue split by nights stayed</p></div>
        <span class="spacer"></span>
        <a class="btn ghost small" href="?month=${shiftMonth(month, -1)}">‹ Prev</a>
        <form method="get"><input type="month" name="month" value="${month}" onchange="this.form.submit()"></form>
        <a class="btn ghost small" href="?month=${shiftMonth(month, 1)}">Next ›</a>
      </div>
      <div class="grid">
        <div class="card stat"><div class="label">Revenue</div><div class="value">${money(p.totalIncome.total)}</div>${delta(p.totalIncome.total, pp.totalIncome.total)}</div>
        <div class="card stat"><div class="label">Expenses</div><div class="value">${money(p.totalExpense.total)}</div>${delta(p.totalExpense.total, pp.totalExpense.total)}</div>
        <div class="card stat"><div class="label">Net profit</div><div class="value">${money(p.net.total)}</div><div class="note">${pct(margin)} margin</div></div>
        <div class="card stat"><div class="label">Occupancy</div><div class="value">${pct(k.total.occupancy)}</div><div class="note">${k.total.nights} of ${k.total.available} nights</div></div>
        <div class="card stat"><div class="label">ADR</div><div class="value">${money(k.total.adrCents)}</div><div class="note">avg nightly room rate</div></div>
        <div class="card stat"><div class="label">Cash on hand (all accounts)</div><div class="value">${money(bal.totalCents)}</div><div class="note">as of ${now}</div></div>
      </div>

      ${flags.length ? html`<h2>🚨 Red flags</h2>${flags.map((f) => html`<div class="alert ${f.bad ? 'bad' : ''}">${f.text}</div>`)}` : ''}

      <h2>By listing</h2>
      <div class="scroll"><table>
        <tr><th>Listing</th><th class="num">Nights</th><th class="num">Occupancy</th><th class="num">ADR</th><th class="num">RevPAR</th><th class="num">Revenue</th><th class="num">Direct costs</th><th class="num">Share of shared costs</th><th class="num">Net profit</th></tr>
        ${k.rows.filter((row) => row.listing.active || p.totalIncome.amounts[row.listing.id]).map((row) => {
          const id = row.listing.id;
          return html`<tr>
            <td>${row.listing.name}</td>
            <td class="num">${row.nights}</td><td class="num">${pct(row.occupancy)}</td>
            <td class="num">${money(row.adrCents)}</td><td class="num">${money(row.revparCents)}</td>
            <td class="num">${money(p.totalIncome.amounts[id])}</td>
            <td class="num">${money(-p.totalExpense.amounts[id])}</td>
            <td class="num">${money(p.allocated[id])}</td>
            <td class="num"><strong>${money(p.netAfterShared[id])}</strong></td>
          </tr>`;
        })}
      </table></div>

      <h2>Pending payouts</h2>
      <div class="scroll"><table>
        <tr><th>Guest</th><th>Listing</th><th>Channel</th><th>Stay</th><th>Expected by</th><th class="num">Amount</th><th></th></tr>
        ${pending.length ? pending.map((b) => html`<tr>
          <td><a href="/bookings/${b.id}/edit">${b.guest_name || '(no name)'}</a></td><td>${b.listing_name}</td><td>${b.channel_name}</td>
          <td>${b.check_in} → ${b.check_out}</td>
          <td>${b.dueDate} ${b.overdue ? html`<span class="pill bad">Overdue</span>` : ''}</td>
          <td class="num">${money(b.payoutCents)}</td>
          <td><form method="post" action="/bookings/${b.id}/received" class="inline"><button class="small ghost">Mark received today</button></form></td>
        </tr>`) : html`<tr><td colspan="7" class="muted">Nothing pending. 👌</td></tr>`}
      </table></div>

      <div class="grid" style="margin-top:8px;align-items:start;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">
        <div><h2>Account balances</h2><div class="scroll"><table>
          ${bal.rows.filter((b) => b.account.active).map((b) => html`<tr><td>${b.account.name}</td><td class="num">${money(b.balanceCents)}</td></tr>`)}
          <tr class="total"><td>Total</td><td class="num">${money(bal.totalCents)}</td></tr>
        </table></div></div>
        <div><h2>Commissions owed to platforms</h2><div class="scroll"><table>
          ${owed.length ? owed.map((o) => html`<tr><td>${o.name}</td><td class="num">${money(o.owed_cents)}</td></tr>`) : html`<tr><td class="muted">Nothing owed.</td></tr>`}
        </table></div><p class="muted" style="font-size:13px">Pay these via “Money in/out → Commission invoice payment”.</p></div>
      </div>

      <p style="margin-top:24px"><a class="btn" href="/bookings/new">+ Booking</a> <a class="btn ghost" href="/transactions/new">+ Expense</a></p>`;
    res.send(layout({ title: 'Dashboard', active: '/', body, flash: res.locals.flash }));
  });

  r.get('/reports/pnl', (req, res) => {
    const now = today();
    const month = now.slice(0, 7);
    let from = isDate(req.query.from) ? req.query.from : monthRange(month).from;
    let to = isDate(req.query.to) ? req.query.to : monthRange(month).to;
    if (to < from) [from, to] = [to, from];
    const basis = req.query.basis === 'cash' ? 'cash' : 'accrual';
    const p = R.profitAndLoss(db, { from, to, basis });
    const shown = p.listings.filter((l) => l.active || p.totalIncome.amounts[l.id] || p.totalExpense.amounts[l.id]);
    const cols = [...shown.map((l) => String(l.id)), 'shared'];

    const y = now.slice(0, 4);
    const presets = [
      ['This month', monthRange(month)],
      ['Last month', monthRange(shiftMonth(month, -1))],
      ['Year to date', { from: `${y}-01-01`, to: now }],
      ['Last year', { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }],
    ];
    const row = (label, amounts, total, cls = '') => html`<tr class="${cls}"><td>${label}</td>${cols.map((c) => html`<td class="num">${money(amounts[c])}</td>`)}<td class="num"><strong>${money(total)}</strong></td></tr>`;
    const section = (title) => html`<tr class="section"><td colspan="${cols.length + 2}">${title}</td></tr>`;
    const qs = `from=${from}&to=${to}&basis=${basis}`;

    const body = html`
      <h1>Profit &amp; Loss</h1>
      <p class="sub">${from} to ${to} · ${basis === 'accrual' ? 'Accrual: booking revenue counted by nights stayed in the period.' : 'Cash: booking revenue counted when the payout landed.'}</p>
      <div class="toolbar">
        <form method="get">
          <label>From<input type="date" name="from" value="${from}"></label>
          <label>To<input type="date" name="to" value="${to}"></label>
          <label>Basis<select name="basis">${options([{ id: 'accrual', name: 'Accrual' }, { id: 'cash', name: 'Cash' }], basis)}</select></label>
          <button class="ghost">Run</button>
        </form>
        <span class="spacer"></span>
        ${presets.map(([label, rg]) => html`<a class="btn ghost small" href="?from=${rg.from}&to=${rg.to}&basis=${basis}">${label}</a>`)}
        <a class="btn ghost small" href="/export/pnl.csv?${qs}">Download CSV</a>
      </div>
      <div class="scroll"><table>
        <tr><th></th>${shown.map((l) => html`<th class="num">${l.name}</th>`)}<th class="num">Shared</th><th class="num">Total</th></tr>
        ${section('Income')}
        ${p.income.map((l) => row(l.label, l.amounts, l.total))}
        ${row('Total income', p.totalIncome.amounts, p.totalIncome.total, 'total')}
        ${section('Expenses')}
        ${p.expense.map((l) => row(l.label, l.amounts, l.total))}
        ${row('Total expenses', p.totalExpense.amounts, p.totalExpense.total, 'total')}
        ${section('Result')}
        ${row('Net profit (direct)', p.net.amounts, p.net.total, 'total')}
        <tr><td>Shared costs allocated</td>${shown.map((l) => html`<td class="num">${money(p.allocated[l.id])}</td>`)}<td class="num">${money(-p.net.amounts.shared)}</td><td></td></tr>
        <tr class="total"><td>Net profit after shared</td>${shown.map((l) => html`<td class="num">${money(p.netAfterShared[l.id])}</td>`)}<td class="num">${money(0)}</td><td class="num">${money(p.net.total)}</td></tr>
      </table></div>
      <p class="muted" style="font-size:13px">Shared = entries not tagged to a listing. They are split evenly across active listings. Transfers and owner draws/contributions are not income or expenses and never appear here.</p>`;
    res.send(layout({ title: 'P&L', active: '/reports/pnl', body }));
  });

  r.get('/reports/trend', (req, res) => {
    const y = /^\d{4}$/.test(req.query.year || '') ? Number(req.query.year) : Number(today().slice(0, 4));
    const months = R.monthlyTrend(db, y);
    const maxAbs = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
    const tot = months.reduce((a, m) => ({ income: a.income + m.income, expense: a.expense + m.expense, net: a.net + m.net, nights: a.nights + m.nights }), { income: 0, expense: 0, net: 0, nights: 0 });
    const bar = (v, color) => html`<div style="height:8px;border-radius:4px;background:${color};width:${Math.max(0, (v / maxAbs) * 100).toFixed(1)}%"></div>`;
    const body = html`
      <div class="toolbar"><div><h1>${y} month by month</h1><p class="sub" style="margin:0">Accrual basis</p></div><span class="spacer"></span>
        <a class="btn ghost small" href="?year=${y - 1}">‹ ${y - 1}</a><a class="btn ghost small" href="?year=${y + 1}">${y + 1} ›</a></div>
      <div class="scroll"><table>
        <tr><th>Month</th><th class="num">Revenue</th><th class="num">Expenses</th><th class="num">Net</th><th class="num">Margin</th><th class="num">Occupancy</th><th class="num">ADR</th><th style="min-width:160px"></th></tr>
        ${months.map((m) => html`<tr>
          <td><a href="/?month=${m.ym}">${monthLabel(m.ym)}</a></td>
          <td class="num">${money(m.income)}</td><td class="num">${money(m.expense)}</td><td class="num"><strong>${money(m.net)}</strong></td>
          <td class="num">${m.income ? pct(m.net / m.income) : '—'}</td>
          <td class="num">${pct(m.occupancy)}</td><td class="num">${money(m.adrCents)}</td>
          <td>${bar(m.income, '#0f6e5c')}<div style="height:3px"></div>${bar(m.expense, '#c9793a')}</td>
        </tr>`)}
        <tr class="total"><td>Year</td><td class="num">${money(tot.income)}</td><td class="num">${money(tot.expense)}</td><td class="num">${money(tot.net)}</td><td class="num">${tot.income ? pct(tot.net / tot.income) : '—'}</td><td class="num"></td><td class="num"></td><td></td></tr>
      </table></div>
      <p class="muted" style="font-size:13px">Bars: <span style="color:#0f6e5c">■</span> revenue <span style="color:#c9793a">■</span> expenses</p>`;
    res.send(layout({ title: 'Trend', active: '/reports/trend', body }));
  });

  r.get('/accounts', (req, res) => {
    const asOf = isDate(req.query.as_of) ? req.query.as_of : today();
    const bal = R.accountBalances(db, asOf);
    const body = html`
      <h1>Accounts</h1>
      <p class="sub">Balances as of ${asOf}. Reconcile these against your actual bank / GCash app monthly. If they don't match, something is missing.</p>
      <div class="toolbar"><form method="get"><label>As of<input type="date" name="as_of" value="${asOf}"></label><button class="ghost">Show</button></form>
        <span class="spacer"></span><a class="btn ghost" href="/settings#accounts">Manage accounts</a></div>
      <div class="scroll"><table>
        <tr><th>Account</th><th>Type</th><th>Opening balance</th><th class="num">Balance</th></tr>
        ${bal.rows.map((b) => html`<tr><td>${b.account.name}${b.account.active ? '' : html` <span class="pill">archived</span>`}</td><td>${b.account.kind}</td><td>${money(b.account.opening_balance_cents)} on ${b.account.opening_date}</td><td class="num"><strong>${money(b.balanceCents)}</strong></td></tr>`)}
        <tr class="total"><td colspan="3">Total</td><td class="num">${money(bal.totalCents)}</td></tr>
      </table></div>`;
    res.send(layout({ title: 'Accounts', active: '/accounts', body }));
  });

  return r;
};
