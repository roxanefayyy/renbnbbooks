const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { centsToInput } = require('../money');
const { isDate, today } = require('../dates');
const { profitAndLoss, payoutCents } = require('../reports');

// Quote for CSV. Text cells starting with = + - @ are prefixed with ' so spreadsheets
// don't execute them as formulas.
function cell(v, { text = false } = {}) {
  let s = v == null ? '' : String(v);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res, name, header, rows) {
  const lines = [header.map((h) => cell(h)).join(','), ...rows.map((r) => r.join(','))];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send('﻿' + lines.join('\r\n'));
}

const money = (c) => centsToInput(c) || '0.00';

module.exports = function exportsRouter(db) {
  const r = express.Router();

  r.get('/bookings.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT b.*, l.name AS listing, ch.name AS channel, a.name AS account
      FROM bookings b JOIN listings l ON l.id = b.listing_id JOIN channels ch ON ch.id = b.channel_id
      LEFT JOIN accounts a ON a.id = b.account_id ORDER BY b.check_in
    `).all();
    sendCsv(res, `renbnb-bookings-${today()}.csv`,
      ['id', 'listing', 'channel', 'guest', 'confirmation', 'check_in', 'check_out', 'guests', 'status', 'gross', 'cleaning_fee', 'commission', 'commission_deducted', 'payout', 'payout_status', 'payout_date', 'account', 'notes'],
      rows.map((b) => [
        b.id, cell(b.listing, { text: true }), cell(b.channel, { text: true }), cell(b.guest_name, { text: true }), cell(b.ref_code, { text: true }),
        b.check_in, b.check_out, b.guests, b.status, money(b.gross_cents), money(b.cleaning_fee_cents), money(b.commission_cents),
        b.commission_deducted ? 'yes' : 'no', money(payoutCents(b)), b.payout_status, b.payout_date || '', cell(b.account, { text: true }), cell(b.notes, { text: true }),
      ]));
  });

  r.get('/transactions.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT t.*, l.name AS listing, c.name AS category, a.name AS account, a2.name AS to_account, ch.name AS channel
      FROM transactions t LEFT JOIN listings l ON l.id = t.listing_id LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts a2 ON a2.id = t.to_account_id
      LEFT JOIN channels ch ON ch.id = t.channel_id ORDER BY t.date, t.id
    `).all();
    sendCsv(res, `renbnb-money-in-out-${today()}.csv`,
      ['id', 'date', 'type', 'amount', 'account', 'to_account', 'listing', 'category', 'platform', 'vendor', 'description', 'receipt_url'],
      rows.map((t) => [
        t.id, t.date, t.type, money(t.amount_cents), cell(t.account, { text: true }), cell(t.to_account, { text: true }),
        cell(t.listing || 'Shared', { text: true }), cell(t.category, { text: true }), cell(t.channel, { text: true }),
        cell(t.vendor, { text: true }), cell(t.description, { text: true }), cell(t.receipt_url, { text: true }),
      ]));
  });

  r.get('/pnl.csv', (req, res) => {
    if (!isDate(req.query.from) || !isDate(req.query.to)) return res.status(400).send('from and to dates required');
    const p = profitAndLoss(db, { from: req.query.from, to: req.query.to, basis: req.query.basis === 'cash' ? 'cash' : 'accrual' });
    const cols = p.cols;
    const line = (label, amounts, total) => [cell(label, { text: true }), ...cols.map((c) => money(amounts[c])), money(total)];
    sendCsv(res, `renbnb-pnl-${p.from}-to-${p.to}-${p.basis}.csv`,
      ['', ...p.listings.map((l) => l.name), 'Shared', 'Total'],
      [
        ...p.income.map((l) => line(l.label, l.amounts, l.total)),
        line('Total income', p.totalIncome.amounts, p.totalIncome.total),
        ...p.expense.map((l) => line(l.label, l.amounts, l.total)),
        line('Total expenses', p.totalExpense.amounts, p.totalExpense.total),
        line('Net profit (direct)', p.net.amounts, p.net.total),
        line('Net profit after shared', { ...Object.fromEntries(p.listings.map((l) => [String(l.id), p.netAfterShared[l.id]])), shared: 0 }, p.net.total),
      ]);
  });

  r.get('/backup.sqlite', (req, res, next) => {
    const tmp = path.join(os.tmpdir(), `renbnb-backup-${process.pid}-${Date.now()}.sqlite`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } catch (e) {
      return next(e);
    }
    res.download(tmp, `renbnb-backup-${today()}.sqlite`, () => fs.rm(tmp, { force: true }, () => {}));
  });

  return r;
};
