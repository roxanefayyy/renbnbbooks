// All money is stored as integer centavos to avoid floating-point drift.

function parseMoney(input) {
  if (input === undefined || input === null) return 0;
  const s = String(input).replace(/[₱,\s]/g, '').replace(/^PHP/i, '');
  if (s === '') return 0;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount: "${input}"`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

function formatMoney(cents, { symbol = true } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${symbol ? '₱' : ''}${whole}.${frac}`;
}

// Plain decimal string for form inputs and CSV ("1234.50").
function centsToInput(cents) {
  if (!cents) return '';
  return formatMoney(cents, { symbol: false }).replace(/,/g, '');
}

module.exports = { parseMoney, formatMoney, centsToInput };
