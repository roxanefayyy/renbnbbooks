// Small validation helpers. Each returns a value or pushes a message onto errors.
const { parseMoney } = require('./money');
const { isDate } = require('./dates');

class FormErrors extends Error {
  constructor(messages) {
    super(messages.join(' '));
    this.messages = messages;
  }
}

function validator(body) {
  const errors = [];
  const v = {
    errors,
    str(name, { max = 500 } = {}) {
      return String(body[name] ?? '').trim().slice(0, max);
    },
    date(name, label, { optional = false } = {}) {
      const s = v.str(name);
      if (!s && optional) return null;
      if (!isDate(s)) { errors.push(`${label} must be a valid date.`); return null; }
      return s;
    },
    money(name, label, { positive = false } = {}) {
      try {
        const c = parseMoney(body[name]);
        if (c < 0 || (positive && c === 0)) errors.push(`${label} must be ${positive ? 'more than zero' : 'zero or more'}.`);
        return c;
      } catch {
        errors.push(`${label} is not a valid amount.`);
        return 0;
      }
    },
    id(name, label, table, db, { optional = false } = {}) {
      const s = v.str(name);
      if (!s && optional) return null;
      const n = Number(s);
      if (!Number.isInteger(n) || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(n)) {
        errors.push(`Pick a ${label}.`);
        return null;
      }
      return n;
    },
    int(name, label, { min = 0, fallback = 0 } = {}) {
      const s = v.str(name);
      if (!s) return fallback;
      const n = Number(s);
      if (!Number.isInteger(n) || n < min) { errors.push(`${label} must be a whole number.`); return fallback; }
      return n;
    },
    bool(name) {
      return body[name] === 'on' || body[name] === '1' || body[name] === 'true' ? 1 : 0;
    },
    oneOf(name, label, allowed) {
      const s = v.str(name);
      if (!allowed.includes(s)) { errors.push(`${label} is invalid.`); return allowed[0]; }
      return s;
    },
    check() {
      if (errors.length) throw new FormErrors(errors);
    },
  };
  return v;
}

module.exports = { validator, FormErrors };
