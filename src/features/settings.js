const express = require('express');
const { html, raw } = require('../html');
const { layout, options } = require('../views');
const { validator, FormErrors } = require('../forms');
const { centsToInput } = require('../money');
const { today } = require('../dates');

// Each editable reference table: its columns, how to render an input, and how to parse it.
// Nothing is ever deleted (history must stay intact); rows are archived via "active".
const TABLES = {
  listings: {
    title: 'Listings',
    hint: 'Your units. Archive a listing you stop operating instead of deleting it.',
    order: 'sort_order, id',
    fields: [
      ['name', 'Name', 'text'],
      ['address', 'Address / building', 'text'],
      ['sort_order', 'Order', 'int'],
      ['active', 'Active', 'bool'],
    ],
  },
  accounts: {
    title: 'Money accounts',
    hint: 'Where money sits: bank, GCash, Maya, cash. Set the opening balance to the real balance on the day you start using this app.',
    order: 'id',
    fields: [
      ['name', 'Name', 'text'],
      ['kind', 'Type', ['bank', 'ewallet', 'cash', 'other']],
      ['opening_balance_cents', 'Opening balance (₱)', 'money'],
      ['opening_date', 'As of', 'date'],
      ['active', 'Active', 'bool'],
    ],
  },
  channels: {
    title: 'Booking channels',
    hint: 'Commission % prefills new bookings. "Deducted" = the platform takes its cut before paying you. Payout lag = days after check-out before a payout counts as overdue.',
    order: 'id',
    fields: [
      ['name', 'Name', 'text'],
      ['commission_rate', 'Commission %', 'rate'],
      ['commission_deducted', 'Deducted from payout', 'bool'],
      ['payout_lag_days', 'Payout lag (days)', 'int'],
      ['active', 'Active', 'bool'],
    ],
  },
  categories: {
    title: 'Categories',
    hint: 'Income and expense categories used in the P&L.',
    order: 'kind DESC, sort_order, id',
    fields: [
      ['name', 'Name', 'text'],
      ['kind', 'Kind', ['expense', 'income']],
      ['grp', 'Group', 'text'],
      ['sort_order', 'Order', 'int'],
      ['active', 'Active', 'bool'],
    ],
  },
};

module.exports = function settings(db) {
  const r = express.Router();

  function input(formId, [name, , type], value) {
    const a = { form: formId, name };
    if (Array.isArray(type)) return html`<select form="${a.form}" name="${name}">${options(type.map((t) => ({ id: t, name: t })), value)}</select>`;
    if (type === 'bool') return html`<input type="checkbox" form="${a.form}" name="${name}" ${value === 0 ? '' : raw('checked')}>`;
    if (type === 'money') return html`<input form="${a.form}" name="${name}" inputmode="decimal" value="${centsToInput(value || 0)}" placeholder="0.00" style="min-width:110px">`;
    if (type === 'date') return html`<input type="date" form="${a.form}" name="${name}" value="${value || today()}">`;
    if (type === 'int' || type === 'rate') return html`<input type="number" step="${type === 'rate' ? '0.1' : '1'}" min="0" form="${a.form}" name="${name}" value="${value ?? 0}" style="width:90px">`;
    return html`<input form="${a.form}" name="${name}" value="${value || ''}" ${name === 'name' ? raw('required') : ''} style="min-width:160px">`;
  }

  function tableSection(key) {
    const t = TABLES[key];
    const rows = db.prepare(`SELECT * FROM ${key} ORDER BY ${t.order}`).all();
    const newId = `${key}-new`;
    return html`
      <h2 id="${key}">${t.title}</h2>
      <p class="muted" style="margin-top:-4px">${t.hint}</p>
      <div class="scroll"><table>
        <tr>${t.fields.map(([, label]) => html`<th>${label}</th>`)}<th></th></tr>
        ${rows.map((row) => {
          const fid = `${key}-${row.id}`;
          return html`<tr>${t.fields.map((f) => html`<td>${input(fid, f, row[f[0]])}</td>`)}
            <td><form id="${fid}" method="post" action="/settings/${key}/${row.id}" class="inline"><button class="small ghost">Save</button></form></td></tr>`;
        })}
        <tr>${t.fields.map((f) => html`<td>${input(newId, f, f[2] === 'bool' ? 1 : undefined)}</td>`)}
          <td><form id="${newId}" method="post" action="/settings/${key}" class="inline"><button class="small">Add</button></form></td></tr>
      </table></div>`;
  }

  r.get('/', (req, res) => {
    const body = html`
      <h1>Settings</h1>
      <p class="sub">Rename the placeholder listings and set your real account opening balances first.</p>
      ${Object.keys(TABLES).map(tableSection)}
      <h2>Backup &amp; export</h2>
      <p><a class="btn ghost" href="/export/bookings.csv">Bookings CSV</a> <a class="btn ghost" href="/export/transactions.csv">Money in/out CSV</a> <a class="btn ghost" href="/export/backup.sqlite">Full database backup</a></p>
      <p class="muted" style="font-size:13px">Download the full backup at least weekly and keep it in Google Drive. It contains everything.</p>`;
    res.send(layout({ title: 'Settings', active: '/settings', body, flash: res.locals.flash }));
  });

  function parse(key, body) {
    const v = validator(body);
    const out = {};
    for (const [name, label, type] of TABLES[key].fields) {
      if (Array.isArray(type)) out[name] = v.oneOf(name, label, type);
      else if (type === 'bool') out[name] = v.bool(name);
      else if (type === 'money') out[name] = v.money(name, label);
      else if (type === 'date') out[name] = v.date(name, label);
      else if (type === 'int') out[name] = v.int(name, label);
      else if (type === 'rate') {
        const n = Number(v.str(name) || 0);
        if (!Number.isFinite(n) || n < 0 || n > 100) v.errors.push(`${label} must be between 0 and 100.`);
        out[name] = n;
      } else out[name] = v.str(name, { max: 200 });
    }
    if (!out.name) v.errors.push('Name is required.');
    v.check();
    return out;
  }

  const back = (res, key, msg) => res.redirect(`/settings?msg=${encodeURIComponent(msg)}#${key}`);

  r.post('/:table', (req, res) => {
    const key = req.params.table;
    if (!TABLES[key]) return res.status(404).end();
    try {
      const row = parse(key, req.body);
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${key} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
      back(res, key, `${TABLES[key].title}: added`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      res.redirect(`/settings?err=${encodeURIComponent(e.message)}#${key}`);
    }
  });

  r.post('/:table/:id', (req, res) => {
    const key = req.params.table;
    if (!TABLES[key]) return res.status(404).end();
    try {
      const row = parse(key, req.body);
      const cols = Object.keys(row);
      db.prepare(`UPDATE ${key} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), Number(req.params.id));
      back(res, key, `${TABLES[key].title}: saved`);
    } catch (e) {
      if (!(e instanceof FormErrors)) throw e;
      res.redirect(`/settings?err=${encodeURIComponent(e.message)}#${key}`);
    }
  });

  return r;
};
