const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { parseCsv } = require('../src/csv');
const I = require('../src/importer');
const R = require('../src/reports');

// Shaped like a Hospitable "Reservations & Financials" export.
const CSV = `﻿Reservation Code,Property Name,Guest Name,Platform,Status,Check-in,Check-out,Nights,Guests,Accommodation,Cleaning Fee,Host Service Fee,Total Payout
HMABC123,"Azure 12F, Parañaque",Maria Cruz,Airbnb,Accepted,09/28/2026,10/02/2026,4,2,"₱8,000.00",₱800.00,-₱264.00,"₱8,536.00"
BK-998,Sunset Loft,"O'Brien, Tom",Booking.com,Confirmed,10/05/2026,10/07/2026,2,1,,₱500.00,,"₱5,000.00"
HMZZZ,Azure 12F,Ann,Airbnb,Cancelled,10/10/2026,10/12/2026,2,1,,,,₱0.00
HMINQ,Azure 12F,Ben,Airbnb,Inquiry,10/15/2026,10/16/2026,1,1,,,,₱1000
HMBAD,Azure 12F,Cy,Airbnb,Accepted,not a date,10/16/2026,1,1,,,,₱1000
`;

test('csv parser handles quotes, commas, BOM', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 6);
  assert.equal(rows[1][1], 'Azure 12F, Parañaque');
  assert.equal(rows[2][2], "O'Brien, Tom");
  assert.equal(rows[0][0], 'Reservation Code');
  assert.deepEqual(parseCsv('a;b\n"x;y";2\r\n'), [['a', 'b'], ['x;y', '2']]);
});

test('field parsers', () => {
  assert.equal(I.parseAmount('"₱8,536.00"'.replace(/"/g, '')), 853600);
  assert.equal(I.parseAmount('-₱264.00'), -26400);
  assert.equal(I.parseAmount('(12.50)'), -1250);
  assert.equal(I.parseAmount('PHP 1,000'), 100000);
  assert.equal(I.parseAmount(''), null);
  assert.equal(I.parseDate('09/28/2026', 'mdy'), '2026-09-28');
  assert.equal(I.parseDate('28/09/2026', 'dmy'), '2026-09-28');
  assert.equal(I.parseDate('2026-09-28 15:00', 'mdy'), '2026-09-28');
  assert.equal(I.parseDate('Sep 28, 2026'), '2026-09-28');
  assert.equal(I.parseDate('28 September 2026'), '2026-09-28');
  assert.equal(I.parseDate('02/30/2026'), null);
  assert.deepEqual(I.detectDateFormat(['28/09/2026', '01/10/2026']), { fmt: 'dmy', sure: true });
  assert.equal(I.detectDateFormat(['01/02/2026']).sure, false);
  assert.equal(I.classifyStatus('Cancelled by guest'), 'cancelled');
  assert.equal(I.classifyStatus('Inquiry'), 'skip');
});

test('column guessing picks the specific match', () => {
  const headers = parseCsv(CSV)[0];
  const c = I.guessColumns(headers);
  const name = (k) => headers[c[k]];
  assert.equal(name('external_id'), 'Reservation Code');
  assert.equal(name('property'), 'Property Name');
  assert.equal(name('payout'), 'Total Payout');
  assert.equal(name('commission'), 'Host Service Fee');
  assert.equal(name('cleaning_fee'), 'Cleaning Fee');
  assert.equal(name('check_out'), 'Check-out');
  assert.equal(c.gross, undefined, '"Accommodation" excludes cleaning, so it must not be guessed as gross');
  // A remembered choice wins over the guess.
  assert.equal(headers[I.guessColumns(headers, { gross: 'Accommodation' }).gross], 'Accommodation');
});

test('plan + commit: amounts, statuses, dedupe, re-import keeps payout status', () => {
  const db = openDb(':memory:');
  const rows = parseCsv(CSV);
  const headers = rows[0];
  const mapping = {
    columns: I.guessColumns(headers),
    dateFormat: 'mdy',
    listingMap: { 'Azure 12F, Parañaque': '1', 'Azure 12F': '1', 'Sunset Loft': 'new' },
    channelMap: {},
  };
  const p = I.plan(db, rows.slice(1), mapping);
  const by = Object.fromEntries(p.map((x) => [x.code || x.line, x]));

  // Airbnb: gross = payout + host fee (deducted).
  assert.equal(by.HMABC123.action, 'new');
  assert.equal(by.HMABC123.booking.gross_cents, 880000);
  assert.equal(by.HMABC123.booking.commission_cents, 26400);
  assert.equal(by.HMABC123.booking.cleaning_fee_cents, 80000);
  // Booking.com invoices separately: gross = payout, commission estimated from channel rate.
  assert.equal(by['BK-998'].booking.gross_cents, 500000);
  assert.equal(by['BK-998'].booking.commission_cents, 75000);
  assert.equal(by['BK-998'].booking.commission_deducted, 0);
  assert.match(by['BK-998'].notes[0], /estimated/);
  assert.equal(by.HMZZZ.booking.status, 'cancelled');
  assert.equal(by.HMINQ.action, 'skip');
  assert.equal(by.HMBAD.action, 'error');

  const c = I.commit(db, p, { markReceivedBefore: '2026-10-03', accountId: 1 });
  assert.equal(c.new, 3);
  assert.equal(c.listingsCreated, 1);
  assert.equal(c.markedReceived, 1); // only HMABC123 checked out by Oct 3
  const abc = db.prepare("SELECT * FROM bookings WHERE external_id = 'HMABC123'").get();
  assert.equal(abc.payout_status, 'received');
  assert.equal(R.payoutCents(abc), 853600);
  assert.equal(db.prepare("SELECT l.name FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE external_id = 'BK-998'").get().name, 'Sunset Loft');

  // Re-import: nothing duplicated; an edited amount is updated; payout status survives.
  const p2 = I.plan(db, rows.slice(1), { ...mapping, listingMap: { ...mapping.listingMap, 'Sunset Loft': String(db.prepare("SELECT id FROM listings WHERE name = 'Sunset Loft'").get().id) } });
  assert.equal(p2.find((x) => x.code === 'HMABC123').action, 'unchanged');
  rows[1][12] = '₱9,000.00';
  const p3 = I.plan(db, rows.slice(1), { ...mapping, listingMap: { ...mapping.listingMap, 'Sunset Loft': String(db.prepare("SELECT id FROM listings WHERE name = 'Sunset Loft'").get().id) } });
  assert.equal(p3.find((x) => x.code === 'HMABC123').action, 'update');
  I.commit(db, p3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 3);
  const abc2 = db.prepare("SELECT * FROM bookings WHERE external_id = 'HMABC123'").get();
  assert.equal(abc2.gross_cents, 926400);
  assert.equal(abc2.payout_status, 'received');
});

test('import links up with a booking already typed in by hand', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO bookings (listing_id, channel_id, ref_code, check_in, check_out, gross_cents, notes) VALUES (1, 1, 'HMABC123', '2026-09-28', '2026-10-02', 100, 'keep me')").run();
  const rows = parseCsv(CSV);
  const p = I.plan(db, rows.slice(1, 2), { columns: I.guessColumns(rows[0]), dateFormat: 'mdy', listingMap: { 'Azure 12F, Parañaque': '1' }, channelMap: {} });
  assert.equal(p[0].action, 'update');
  I.commit(db, p);
  const all = db.prepare('SELECT * FROM bookings').all();
  assert.equal(all.length, 1);
  assert.equal(all[0].source, 'hospitable');
  assert.equal(all[0].notes, 'keep me');
});
