// Turns a reservations CSV (built for Hospitable's "Reservations & Financials" export, but works
// for any similar file) into bookings. The user confirms which column is which once; choices
// are remembered for next time. Re-importing the same file updates bookings, never duplicates.
const { isDate, addDays, diffDays } = require('./dates');

const SOURCE = 'hospitable';

// aliases are matched against normalised header text (lowercase, punctuation → spaces).
const FIELDS = [
  { key: 'external_id', label: 'Confirmation / reservation code', required: true, aliases: ['confirmation code', 'reservation code', 'confirmation', 'reservation id', 'booking id', 'booking reference', 'code', 'reservation', 'id'] },
  { key: 'property', label: 'Property / listing', required: true, aliases: ['property name', 'listing name', 'property', 'listing', 'unit', 'rental'] },
  { key: 'check_in', label: 'Check-in date', required: true, aliases: ['check in date', 'check in', 'checkin', 'arrival date', 'arrival', 'start date'] },
  { key: 'check_out', label: 'Check-out date', aliases: ['check out date', 'check out', 'checkout', 'departure date', 'departure', 'end date'] },
  { key: 'nights', label: 'Nights (used if no check-out)', aliases: ['number of nights', 'nights', 'night count', 'length of stay'] },
  { key: 'guest_name', label: 'Guest name', aliases: ['guest name', 'guest full name', 'guest', 'name'] },
  { key: 'guests', label: 'Number of guests', aliases: ['number of guests', 'guest count', 'guests', 'adults'] },
  { key: 'channel', label: 'Platform / channel', aliases: ['platform', 'channel', 'booking source', 'source', 'ota'] },
  { key: 'status', label: 'Reservation status', aliases: ['reservation status', 'status'] },
  { key: 'gross', label: 'Gross: what the guest paid for the stay (before platform fee)', aliases: ['gross revenue', 'gross earnings', 'total price', 'booking amount', 'gross', 'revenue', 'total'] },
  { key: 'payout', label: 'Host payout (after platform fee)', aliases: ['host payout', 'net payout', 'expected payout', 'total payout', 'your earnings', 'net revenue', 'payout', 'earnings'] },
  { key: 'cleaning_fee', label: 'Cleaning fee', aliases: ['cleaning fees', 'cleaning fee', 'cleaning'] },
  { key: 'commission', label: 'Platform fee / commission', aliases: ['host service fee', 'booking com commission', 'ota commission', 'channel fee', 'platform fee', 'airbnb fee', 'host fee', 'commission', 'service fee'] },
];

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Returns { fieldKey: columnIndex }. `saved` maps fieldKey -> header text from a previous import.
function guessColumns(headers, saved = {}) {
  const h = headers.map(norm);
  const used = new Set();
  const out = {};
  for (const f of FIELDS) {
    const prev = saved[f.key] != null ? h.indexOf(norm(saved[f.key])) : -1;
    if (prev >= 0 && !used.has(prev)) { out[f.key] = prev; used.add(prev); }
  }
  // Exact alias matches first, then "header contains alias". Longer aliases go first so
  // "total payout" is claimed by payout before "total" can claim it for gross.
  const pairs = FIELDS.flatMap((f) => f.aliases.map((a) => [f.key, a])).sort((a, b) => b[1].length - a[1].length);
  for (const pass of ['exact', 'contains']) {
    for (const [key, a] of pairs) {
      if (out[key] != null) continue;
      const i = h.findIndex((x, idx) => !used.has(idx) && (pass === 'exact' ? x === a : a.length > 3 && x.includes(a)));
      if (i >= 0) { out[key] = i; used.add(i); }
    }
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// fmt: 'ymd' | 'mdy' | 'dmy'. Accepts 2026-09-01, 9/1/2026, 01.09.2026, "Sep 1, 2026", "1 Sep 2026", with optional time.
function parseDate(s, fmt = 'mdy') {
  s = String(s || '').trim();
  if (!s) return null;
  let y, m, d;
  let x;
  if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [, y, m, d] = x;
  else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) {
    [, m, d, y] = x;
    if (fmt === 'dmy') [m, d] = [d, m];
    if (y.length === 2) y = `20${y}`;
  } else if ((x = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s))) {
    m = MONTHS.indexOf(x[1].toLowerCase()) + 1; d = x[2]; y = x[3];
  } else if ((x = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/i.exec(s))) {
    d = x[1]; m = MONTHS.indexOf(x[2].toLowerCase()) + 1; y = x[3];
  } else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDate(iso) ? iso : null;
}

// Picks the day/month order from the data: any first part > 12 means day-first.
function detectDateFormat(values) {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const x = /^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/.exec(String(v).trim());
    if (!x) continue;
    if (Number(x[1]) > 12) dmy = true;
    if (Number(x[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return { fmt: 'dmy', sure: true };
  if (mdy && !dmy) return { fmt: 'mdy', sure: true };
  const iso = values.some((v) => /^\d{4}-/.test(String(v).trim()));
  return { fmt: iso ? 'ymd' : 'mdy', sure: iso || !values.some((v) => /^\d{1,2}[-/.]/.test(String(v).trim())) };
}

// "PHP 1,234.50", "₱1,234", "$(12.00)", "-300" -> centavos. Blank -> null.
function parseAmount(s) {
  let t = String(s ?? '').trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-|-$/.test(t.replace(/[^0-9.\-()]/g, ''));
  t = t.replace(/[^0-9.]/g, '');
  if (!t || !/^\d*\.?\d*$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return Number.isFinite(cents) ? (neg ? -cents : cents) : null;
}

function guessChannel(value, channels) {
  const v = norm(value);
  const by = (re) => channels.find((c) => re.test(norm(c.name)));
  if (/airbnb/.test(v)) return by(/airbnb/);
  if (/booking/.test(v)) return by(/booking/);
  if (/agoda/.test(v)) return by(/agoda/);
  if (!v || /direct|manual|website|hospitable|owner/.test(v)) return by(/direct/);
  return by(/other/);
}

function classifyStatus(s) {
  const v = norm(s);
  if (/cancel/.test(v)) return 'cancelled';
  if (/declin|expire|inquir|denied|request|pending|withdraw/.test(v)) return 'skip';
  return 'confirmed';
}

const COMPARE = ['listing_id', 'channel_id', 'guest_name', 'check_in', 'check_out', 'guests', 'gross_cents', 'cleaning_fee_cents', 'commission_cents', 'commission_deducted', 'status'];

/**
 * Work out what importing would do, without writing anything.
 * mapping: { columns: {field: index}, dateFormat, listingMap: {propertyValue: listingId|'new'|'skip'}, channelMap: {value: channelId} }
 */
function plan(db, rows, mapping) {
  const channels = db.prepare('SELECT * FROM channels').all();
  const chById = new Map(channels.map((c) => [c.id, c]));
  const listingIds = new Set(db.prepare('SELECT id FROM listings').all().map((l) => l.id));
  const { columns = {}, dateFormat = 'mdy', listingMap = {}, channelMap = {} } = mapping;
  const get = (row, key) => (columns[key] != null && columns[key] !== '' ? String(row[columns[key]] ?? '').trim() : '');
  const has = (key) => columns[key] != null && columns[key] !== '';
  const findExisting = db.prepare(`SELECT * FROM bookings WHERE (source = ? AND external_id = ?) OR (source = 'manual' AND external_id IS NULL AND ref_code = ? AND ref_code <> '') ORDER BY source = ? DESC LIMIT 1`);
  const seen = new Set();

  return rows.map((row, i) => {
    const line = i + 2; // +1 header, +1 human counting
    const out = { line, notes: [] };
    const err = (reason) => Object.assign(out, { action: 'error', reason });
    const skip = (reason) => Object.assign(out, { action: 'skip', reason });

    const code = get(row, 'external_id');
    if (!code) return err('No confirmation code');
    if (seen.has(code)) return skip('Duplicate row in this file');
    seen.add(code);
    out.code = code;

    const status = has('status') ? classifyStatus(get(row, 'status')) : 'confirmed';
    if (status === 'skip') return skip(`Status "${get(row, 'status')}" is not a booking`);

    const property = get(row, 'property');
    out.property = property;
    const lm = listingMap[property];
    if (lm === 'skip') return skip('Property set to skip');
    if (lm !== 'new' && !listingIds.has(Number(lm))) return err(`Choose a listing for "${property || '(blank)'}"`);

    const checkIn = parseDate(get(row, 'check_in'), dateFormat);
    if (!checkIn) return err(`Can't read check-in "${get(row, 'check_in')}"`);
    let checkOut = has('check_out') ? parseDate(get(row, 'check_out'), dateFormat) : null;
    if (!checkOut && has('nights')) {
      const n = Number(get(row, 'nights'));
      if (Number.isInteger(n) && n >= 0) checkOut = addDays(checkIn, n);
    }
    if (!checkOut) return err(`Can't read check-out "${get(row, 'check_out')}"`);
    if (checkOut < checkIn) return err('Check-out is before check-in');

    const channelValue = get(row, 'channel');
    const channel = chById.get(Number(channelMap[channelValue])) || guessChannel(channelValue, channels);
    if (!channel) return err(`Choose a channel for "${channelValue}"`);
    const deducted = channel.commission_deducted;

    const abs = (x) => (x == null ? null : Math.abs(x));
    let gross = abs(parseAmount(get(row, 'gross')));
    const payout = abs(parseAmount(get(row, 'payout')));
    let commission = abs(parseAmount(get(row, 'commission')));
    const cleaning = abs(parseAmount(get(row, 'cleaning_fee'))) || 0;
    if (gross == null && payout != null) gross = payout + (deducted ? commission || 0 : 0);
    if (commission == null && gross != null && payout != null && deducted) commission = Math.max(0, gross - payout);
    if (gross == null) {
      if (status === 'cancelled') gross = 0;
      else return err('No amount: map a Gross or Payout column');
    }
    if (commission == null) {
      commission = Math.round((gross * channel.commission_rate) / 100);
      if (commission) out.notes.push(`commission estimated at ${channel.commission_rate}%`);
    }
    if (cleaning > gross) return err('Cleaning fee is more than the gross amount');
    if (commission > gross) return err('Commission is more than the gross amount');

    const guestsN = Number(get(row, 'guests'));
    out.booking = {
      listing_id: lm === 'new' ? null : Number(lm),
      new_listing_name: lm === 'new' ? property : null,
      channel_id: channel.id,
      channel_name: channel.name,
      guest_name: get(row, 'guest_name').slice(0, 120),
      ref_code: code.slice(0, 60),
      check_in: checkIn,
      check_out: checkOut,
      nights: diffDays(checkIn, checkOut),
      guests: Number.isInteger(guestsN) && guestsN > 0 ? guestsN : 1,
      gross_cents: gross,
      cleaning_fee_cents: cleaning,
      commission_cents: commission,
      commission_deducted: deducted,
      status,
    };

    const existing = findExisting.get(SOURCE, code, code, SOURCE);
    if (existing) {
      out.existingId = existing.id;
      out.existingPayoutStatus = existing.payout_status;
      const changed = lm !== 'new' && COMPARE.some((k) => String(existing[k]) !== String(out.booking[k]));
      out.action = changed || lm === 'new' || existing.source !== SOURCE ? 'update' : 'unchanged';
    } else out.action = 'new';
    return out;
  });
}

/**
 * Write a plan. Payout status, payout date, account and notes on existing bookings are
 * never touched, since those are managed in the app. Optionally mark payouts received
 * for stays that checked out on/before `markReceivedBefore`.
 */
function commit(db, planned, { markReceivedBefore = null, accountId = null, userId = null } = {}) {
  const counts = { new: 0, update: 0, unchanged: 0, skip: 0, error: 0, listingsCreated: 0, markedReceived: 0 };
  const newListing = new Map();
  db.exec('BEGIN');
  try {
    const maxOrder = () => db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM listings').get().m;
    const insert = db.prepare(`INSERT INTO bookings (listing_id, channel_id, guest_name, ref_code, check_in, check_out, guests, gross_cents, cleaning_fee_cents, commission_cents, commission_deducted, status, payout_status, source, external_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`);
    const update = db.prepare(`UPDATE bookings SET listing_id = ?, channel_id = ?, guest_name = ?, ref_code = ?, check_in = ?, check_out = ?, guests = ?, gross_cents = ?, cleaning_fee_cents = ?, commission_cents = ?, commission_deducted = ?, status = ?, source = ?, external_id = ?, updated_at = datetime('now') WHERE id = ?`);
    const received = db.prepare("UPDATE bookings SET payout_status = 'received', payout_date = ?, account_id = ?, updated_at = datetime('now') WHERE id = ? AND payout_status = 'pending'");

    for (const p of planned) {
      counts[p.action] += 1;
      if (!['new', 'update', 'unchanged'].includes(p.action)) continue;
      const b = p.booking;
      let listingId = b.listing_id;
      if (listingId == null) {
        if (!newListing.has(b.new_listing_name)) {
          const r = db.prepare('INSERT INTO listings (name, sort_order) VALUES (?, ?)').run(b.new_listing_name || 'Imported listing', maxOrder() + 1);
          newListing.set(b.new_listing_name, Number(r.lastInsertRowid));
          counts.listingsCreated += 1;
        }
        listingId = newListing.get(b.new_listing_name);
      }
      const vals = [listingId, b.channel_id, b.guest_name, b.ref_code, b.check_in, b.check_out, b.guests, b.gross_cents, b.cleaning_fee_cents, b.commission_cents, b.commission_deducted, b.status];
      let id = p.existingId;
      if (p.action === 'new') id = Number(insert.run(...vals, SOURCE, p.code, userId).lastInsertRowid);
      else if (p.action === 'update') update.run(...vals, SOURCE, p.code, id);
      if (markReceivedBefore && accountId && b.check_out <= markReceivedBefore && b.status === 'confirmed') {
        counts.markedReceived += Number(received.run(b.check_out, accountId, id).changes);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}

module.exports = { FIELDS, SOURCE, guessColumns, parseDate, detectDateFormat, parseAmount, guessChannel, classifyStatus, plan, commit };
