// Dates are plain 'YYYY-MM-DD' strings. Arithmetic is done in UTC so there are
// no DST or timezone surprises; "today" is taken in Manila time.

const DAY_MS = 86400000;
const TZ = process.env.TZ_BUSINESS || 'Asia/Manila';

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toUTC(s) {
  return Date.parse(s + 'T00:00:00Z');
}

function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromUTC(toUTC(s) + n * DAY_MS);
}

// Number of days from a to b (b exclusive), e.g. nights between check-in and check-out.
function diffDays(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const to = fromUTC(Date.UTC(y, m, 0));
  return { from, to };
}

function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function min(a, b) {
  return a < b ? a : b;
}

function max(a, b) {
  return a > b ? a : b;
}

module.exports = { isDate, addDays, diffDays, today, isMonth, monthRange, shiftMonth, monthLabel, min, max };
