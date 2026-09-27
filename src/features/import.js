const express = require('express');
const { html, raw } = require('../html');
const { layout, money, options } = require('../views');
const { parseCsv } = require('../csv');
const { today, isDate } = require('../dates');
const I = require('../importer');

const KV_KEY = 'import:hospitable';
const MAX_BYTES = 10 * 1024 * 1024;

module.exports = function importRouter(db) {
  const r = express.Router();
  const bigBody = express.urlencoded({ extended: false, limit: MAX_BYTES });

  const saved = () => JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY)?.value || '{}');
  const save = (v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KV_KEY, JSON.stringify(v));

  function loadBatch(req, res) {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(Number(req.params.id));
    if (!b) { res.redirect('/import?err=' + encodeURIComponent('That upload expired. Please upload the file again.')); return null; }
    const rows = parseCsv(b.csv_text);
    return { batch: b, headers: rows[0], rows: rows.slice(1), mapping: JSON.parse(b.mapping) };
  }
  const setMapping = (id, m) => db.prepare('UPDATE import_batches SET mapping = ? WHERE id = ?').run(JSON.stringify(m), id);

  const steps = (n) => html`<p class="muted" style="font-size:13px">${['1. Upload', '2. Confirm columns', '3. Match & preview'].map((label, i) =>
    html`${i ? ' → ' : ''}${i + 1 === n ? html`<strong style="color:var(--ink)">${label}</strong>` : label}`)}</p>`;

  r.get('/', (req, res) => {
    const body = html`
      <h1>Import bookings from Hospitable</h1>
      ${steps(1)}
      <div class="card" style="max-width:720px">
        <p><strong>In Hospitable:</strong> Metrics → Exports → <em>Reservations &amp; Financials</em>. Pick the date range, include all the financial columns, and download the CSV.</p>
        <p class="muted">Safe to re-import overlapping date ranges: bookings are matched on their confirmation code and updated, never duplicated. Payout status and notes you set here are kept.</p>
        <form method="post" action="/import/upload" id="up">
          <label>CSV file<input type="file" accept=".csv,text/csv" id="file" required></label>
          <input type="hidden" name="filename" id="filename">
          <textarea name="csv_text" id="csv" hidden></textarea>
          <p><button id="go">Upload</button></p>
        </form>
      </div>
      <script>
        document.getElementById('up').addEventListener('submit', (e) => {
          e.preventDefault();
          const f = document.getElementById('file').files[0];
          if (!f) return;
          if (f.size > ${MAX_BYTES}) return alert('File is over 10 MB. Export a shorter date range.');
          const r = new FileReader();
          r.onload = () => { document.getElementById('csv').value = r.result; document.getElementById('filename').value = f.name; e.target.submit(); };
          r.readAsText(f);
        });
      </script>`;
    res.send(layout({ title: 'Import', active: '/bookings', body, flash: res.locals.flash }));
  });

  r.post('/upload', bigBody, (req, res) => {
    const text = String(req.body.csv_text || '');
    const rows = parseCsv(text);
    if (rows.length < 2) return res.redirect('/import?err=' + encodeURIComponent('That file has no booking rows. Check it is the CSV export.'));
    db.prepare("DELETE FROM import_batches WHERE created_at < datetime('now', '-1 day')").run();
    const s = saved();
    const columns = I.guessColumns(rows[0], s.columnsByHeader);
    const ci = columns.check_in;
    const det = ci != null ? I.detectDateFormat(rows.slice(1).map((r) => r[ci])) : { fmt: 'mdy', sure: false };
    const dateFormat = det.sure ? det.fmt : s.dateFormat || det.fmt;
    const { lastInsertRowid } = db.prepare('INSERT INTO import_batches (filename, csv_text, mapping) VALUES (?, ?, ?)')
      .run(String(req.body.filename || '').slice(0, 200), text, JSON.stringify({ columns, dateFormat }));
    res.redirect(`/import/${lastInsertRowid}/columns`);
  });

  r.get('/:id/columns', (req, res) => {
    const ctx = loadBatch(req, res);
    if (!ctx) return;
    const { batch, headers, rows, mapping } = ctx;
    const sample = (i) => rows.slice(0, 3).map((r) => r[i]).filter(Boolean).join(' · ').slice(0, 60);
    const colOpts = headers.map((h, i) => ({ id: i, name: `${h}${sample(i) ? `  (e.g. ${sample(i)})` : ''}` }));
    const det = mapping.columns.check_in != null ? I.detectDateFormat(rows.map((r) => r[mapping.columns.check_in])) : { sure: false };
    const body = html`
      <h1>Confirm columns</h1>
      ${steps(2)}
      <p class="sub">${batch.filename || 'Upload'} · ${rows.length} rows. I've guessed which column is which. Check them, especially the money ones. Leave a field blank if the file doesn't have it.</p>
      <form method="post" class="card" style="max-width:900px">
        <div class="scroll" style="border:0"><table>
          ${I.FIELDS.map((f) => html`<tr><td style="white-space:normal;width:40%"><strong>${f.label}</strong>${f.required ? html` <span class="pill warn">required</span>` : ''}</td>
            <td><select name="col_${f.key}">${options(colOpts, mapping.columns[f.key], { blank: '— not in file —' })}</select></td></tr>`)}
          <tr><td><strong>Date format</strong>${det.sure ? '' : html`<div class="hint">Can't tell from the data whether 03/04 is March 4 or 3 April. Check a booking after importing.</div>`}</td>
            <td><select name="date_format">${options([{ id: 'mdy', name: 'Month/Day/Year (09/27/2026)' }, { id: 'dmy', name: 'Day/Month/Year (27/09/2026)' }, { id: 'ymd', name: 'Year-Month-Day (2026-09-27)' }], mapping.dateFormat)}</select></td></tr>
        </table></div>
        <p class="muted" style="font-size:13px">Money: map <em>Gross</em> if the file has what the guest paid; otherwise map <em>Host payout</em> + <em>Platform fee</em> and gross is worked out. If there's no fee column, the channel's usual commission % from Settings is used.</p>
        <p><button>Next: match &amp; preview</button> <a class="btn ghost" href="/import">Start over</a></p>
      </form>`;
    res.send(layout({ title: 'Import: columns', active: '/bookings', body, flash: res.locals.flash }));
  });

  r.post('/:id/columns', (req, res) => {
    const ctx = loadBatch(req, res);
    if (!ctx) return;
    const columns = {};
    for (const f of I.FIELDS) {
      const v = req.body[`col_${f.key}`];
      const n = Number(v);
      if (v !== '' && v != null && Number.isInteger(n) && n >= 0 && n < ctx.headers.length) columns[f.key] = n;
    }
    const missing = I.FIELDS.filter((f) => f.required && columns[f.key] == null).map((f) => f.label);
    if (columns.check_out == null && columns.nights == null) missing.push('Check-out date or Nights');
    if (columns.gross == null && columns.payout == null) missing.push('Gross or Host payout');
    const dateFormat = ['mdy', 'dmy', 'ymd'].includes(req.body.date_format) ? req.body.date_format : 'mdy';
    setMapping(ctx.batch.id, { ...ctx.mapping, columns, dateFormat });
    if (missing.length) return res.redirect(`/import/${ctx.batch.id}/columns?err=${encodeURIComponent(`Still needed: ${missing.join(', ')}.`)}`);
    res.redirect(`/import/${ctx.batch.id}/review`);
  });

  // Distinct property / platform values in the file, with the current or best-guess choice for each.
  function valueMaps(ctx) {
    const { rows, mapping } = ctx;
    const s = saved();
    const listings = db.prepare('SELECT * FROM listings ORDER BY sort_order, id').all();
    const channels = db.prepare('SELECT * FROM channels ORDER BY id').all();
    const distinct = (key) => (mapping.columns[key] == null ? [''] : [...new Set(rows.map((r) => String(r[mapping.columns[key]] ?? '').trim()))].sort());
    const listingMap = {};
    for (const p of distinct('property')) {
      const prev = mapping.listingMap?.[p] ?? s.listingMap?.[p];
      const valid = prev === 'new' || prev === 'skip' || listings.some((l) => String(l.id) === String(prev));
      listingMap[p] = valid ? prev : listings.find((l) => l.name.trim().toLowerCase() === p.toLowerCase())?.id ?? '';
    }
    const channelMap = {};
    for (const c of distinct('channel')) {
      const prev = mapping.channelMap?.[c] ?? s.channelMap?.[c];
      channelMap[c] = channels.some((x) => String(x.id) === String(prev)) ? prev : I.guessChannel(c, channels)?.id ?? '';
    }
    return { listings, channels, listingMap, channelMap };
  }

  r.get('/:id/review', (req, res) => {
    const ctx = loadBatch(req, res);
    if (!ctx) return;
    const { listings, channels, listingMap, channelMap } = valueMaps(ctx);
    const planned = I.plan(db, ctx.rows, { ...ctx.mapping, listingMap, channelMap });
    const count = (a) => planned.filter((p) => p.action === a).length;
    const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();
    const listingOpts = [...listings.filter((l) => l.active).map((l) => ({ id: l.id, name: l.name })), { id: 'new', name: '+ Create a new listing with this name' }, { id: 'skip', name: "Skip: don't import" }];
    const order = { error: 0, new: 1, update: 2, skip: 3, unchanged: 4 };
    const shown = [...planned].sort((a, b) => order[a.action] - order[b.action] || a.line - b.line).slice(0, 400);
    const pill = { new: 'ok', update: 'warn', unchanged: '', skip: '', error: 'bad' };
    const willWrite = count('new') + count('update');

    const body = html`
      <h1>Match &amp; preview</h1>
      ${steps(3)}
      <form method="post" class="card" style="max-width:900px">
        <h2 style="margin-top:0">Properties → your listings</h2>
        <div class="scroll" style="border:0"><table>
          ${Object.entries(listingMap).map(([p, v], i) => html`<tr><td style="white-space:normal">${p || html`<span class="muted">(blank)</span>`}</td>
            <td><input type="hidden" name="lv_${i}" value="${p}"><select name="lm_${i}" required>${options(listingOpts, v, { blank: '— choose —' })}</select></td></tr>`)}
        </table></div>
        <h2>Platforms → channels</h2>
        <div class="scroll" style="border:0"><table>
          ${Object.entries(channelMap).map(([c, v], i) => html`<tr><td>${c || html`<span class="muted">(blank / not in file)</span>`}</td>
            <td><input type="hidden" name="cv_${i}" value="${c}"><select name="cm_${i}">${options(channels, v)}</select></td></tr>`)}
        </table></div>
        <h2>Payouts</h2>
        <label class="check" style="margin-top:0"><input type="checkbox" name="mark_received" id="mr"> Mark payouts as <strong>&nbsp;received&nbsp;</strong> for stays that checked out on or before</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
          <label>Date<input type="date" name="received_before" value="${today()}"></label>
          <label>Paid into<select name="received_account">${options(accounts, accounts[0]?.id)}</select></label>
        </div>
        <p class="hint">Use this when back-loading old bookings you know were paid. The payout date is set to the check-out date. Leave it off for anything you still need to check.</p>
        <p style="margin-top:18px">
          <button name="action" value="preview" class="ghost">Update preview</button>
          <button name="action" value="commit" ${willWrite ? '' : raw('disabled')}>Import ${willWrite} booking${willWrite === 1 ? '' : 's'}</button>
          <a class="btn ghost" href="/import/${ctx.batch.id}/columns">‹ Back to columns</a>
        </p>
      </form>

      <h2>Preview</h2>
      <div class="grid" style="margin-bottom:14px">
        <div class="card stat"><div class="label">New</div><div class="value">${count('new')}</div></div>
        <div class="card stat"><div class="label">Updated</div><div class="value">${count('update')}</div></div>
        <div class="card stat"><div class="label">Already up to date</div><div class="value">${count('unchanged')}</div></div>
        <div class="card stat"><div class="label">Skipped</div><div class="value">${count('skip')}</div><div class="note">inquiries, declined, duplicates</div></div>
        <div class="card stat"><div class="label">Problems</div><div class="value ${count('error') ? 'neg' : ''}">${count('error')}</div><div class="note">not imported until fixed</div></div>
      </div>
      <div class="scroll"><table>
        <tr><th>Row</th><th>Result</th><th>Code</th><th>Listing</th><th>Channel</th><th>Guest</th><th>Stay</th><th class="num">Gross</th><th class="num">Commission</th><th>Notes</th></tr>
        ${shown.map((p) => html`<tr>
          <td>${p.line}</td><td><span class="pill ${pill[p.action]}">${p.action}</span></td><td>${p.code || ''}</td>
          <td>${p.booking ? (p.booking.listing_id ? listings.find((l) => l.id === p.booking.listing_id)?.name : html`<em>new: ${p.booking.new_listing_name}</em>`) : p.property || ''}</td>
          <td>${p.booking?.channel_name || ''}</td><td>${p.booking?.guest_name || ''}</td>
          <td>${p.booking ? `${p.booking.check_in} → ${p.booking.check_out} (${p.booking.nights}n)` : ''}${p.booking?.status === 'cancelled' ? html` <span class="pill bad">cancelled</span>` : ''}</td>
          <td class="num">${p.booking ? money(p.booking.gross_cents) : ''}</td><td class="num">${p.booking ? money(p.booking.commission_cents) : ''}</td>
          <td class="${p.action === 'error' ? 'neg' : 'muted'}" style="white-space:normal">${p.reason || p.notes.join('; ')}</td>
        </tr>`)}
      </table></div>
      ${planned.length > shown.length ? html`<p class="muted">Showing ${shown.length} of ${planned.length} rows.</p>` : ''}`;
    res.send(layout({ title: 'Import: preview', active: '/bookings', body, flash: res.locals.flash }));
  });

  r.post('/:id/review', (req, res) => {
    const ctx = loadBatch(req, res);
    if (!ctx) return;
    const collect = (vk, mk) => {
      const out = {};
      for (let i = 0; req.body[`${vk}_${i}`] !== undefined; i++) out[req.body[`${vk}_${i}`]] = req.body[`${mk}_${i}`] || '';
      return out;
    };
    const mapping = { ...ctx.mapping, listingMap: collect('lv', 'lm'), channelMap: collect('cv', 'cm') };
    setMapping(ctx.batch.id, mapping);
    if (req.body.action !== 'commit') return res.redirect(`/import/${ctx.batch.id}/review`);

    const planned = I.plan(db, ctx.rows, mapping);
    const accountId = Number(req.body.received_account);
    const markReceived = req.body.mark_received === 'on' && isDate(req.body.received_before)
      && db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId);
    const c = I.commit(db, planned, markReceived ? { markReceivedBefore: req.body.received_before, accountId, userId: res.locals.user.id || null } : { userId: res.locals.user.id || null });

    // Remember choices so next month's import is one click.
    const s = saved();
    const columnsByHeader = Object.fromEntries(Object.entries(mapping.columns).map(([k, i]) => [k, ctx.headers[i]]));
    save({
      columnsByHeader,
      dateFormat: mapping.dateFormat,
      listingMap: { ...s.listingMap, ...mapping.listingMap },
      channelMap: { ...s.channelMap, ...mapping.channelMap },
    });
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(ctx.batch.id);

    const parts = [`${c.new} new`, `${c.update} updated`, `${c.unchanged} unchanged`];
    if (c.error) parts.push(`${c.error} with problems not imported`);
    if (c.listingsCreated) parts.push(`${c.listingsCreated} listing(s) created`);
    if (c.markedReceived) parts.push(`${c.markedReceived} payout(s) marked received`);
    res.redirect(`/bookings?msg=${encodeURIComponent(`Import done: ${parts.join(', ')}.`)}`);
  });

  return r;
};
