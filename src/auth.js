const crypto = require('node:crypto');

// scrypt with a per-user salt. Stored as "scrypt$<salt hex>$<hash hex>".
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [algo, saltHex, hashHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(got, want);
}

// What each role may open. Admin: everything. Encoder: record expenses and
// approved income (e.g. parking), and see/edit their own entries. Nothing else.
const ENCODER_PATHS = [/^\/transactions(\/|$)/, /^\/logout$/];

function allowed(user, req) {
  if (user.role === 'admin') return true;
  return ENCODER_PATHS.some((re) => re.test(req.path));
}

module.exports = { hashPassword, verifyPassword, allowed };
