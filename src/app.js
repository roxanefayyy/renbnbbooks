const express = require('express');
const crypto = require('node:crypto');
const { html } = require('./html');
const { layout, currentUser } = require('./views');
const { verifyPassword, allowed } = require('./auth');

const COOKIE = 'rb_session';
const SESSION_DAYS = 30;

/**
 * Logins: team members are rows in `users` (Settings → Team). The APP_PASSWORD env var is
 * the owner's recovery login (username "admin"), which always works. With neither set, the
 * app runs open as admin, which is only for local development.
 */
function createApp(db, { password = process.env.APP_PASSWORD, secret = process.env.SESSION_SECRET } = {}) {
  const app = express();
  const key = secret || crypto.randomBytes(32).toString('hex');
  const ENV_ADMIN = { id: 0, name: 'Owner (admin)', username: 'admin', role: 'admin', password_hash: password ? `env:${password}` : '' };
  const hasUsers = () => !!db.prepare('SELECT 1 FROM users WHERE active = 1').get();
  const openMode = () => !password && !hasUsers();

  app.disable('x-powered-by');
  // CSV uploads get a bigger limit, parsed inside the import router (after the login check).
  const smallBody = express.urlencoded({ extended: false, limit: '100kb' });
  app.use((req, res, next) => (req.path === '/import/upload' ? next() : smallBody(req, res, next)));
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // The session is bound to the user's current password hash, so changing a password
  // or deactivating a user logs them out everywhere.
  const sign = (u, exp) => crypto.createHmac('sha256', key).update(`rb:${u.id}:${exp}:${u.password_hash}`).digest('hex');
  const findUser = (id) => (id === 0 ? (password ? ENV_ADMIN : null) : db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id));
  const readCookie = (req) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const sessionUser = (req) => {
    const [id, exp, mac] = (readCookie(req) || '').split('.');
    if (!id || !exp || !mac || Number(exp) < Date.now()) return null;
    const u = findUser(Number(id));
    if (!u) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(u, exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
  };

  const failures = new Map(); // ip -> { count, until }
  const loginPage = (res, error, status = 200) => res.status(status).send(layout({
    title: 'Log in',
    bare: true,
    body: html`<div class="login card"><h1>RenBNB Books</h1>
      ${error ? html`<div class="flash err">${error}</div>` : ''}
      <form method="post" action="/login">
        <label>Username<input name="username" autocomplete="username" autofocus required></label>
        <label style="margin-top:12px">Password<input type="password" name="password" autocomplete="current-password" required></label>
        <p><button>Log in</button></p></form></div>`,
  }));

  app.get('/login', (req, res) => (openMode() ? res.redirect('/') : loginPage(res)));
  app.post('/login', (req, res) => {
    if (openMode()) return res.redirect('/');
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) return loginPage(res, 'Too many attempts. Try again in 15 minutes.', 429);
    const username = String(req.body.username || '').trim();
    const pw = String(req.body.password || '');
    let user = null;
    if (password && username.toLowerCase() === 'admin') {
      const given = crypto.createHash('sha256').update(pw).digest();
      const want = crypto.createHash('sha256').update(password).digest();
      if (crypto.timingSafeEqual(given, want)) user = ENV_ADMIN;
    } else {
      const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
      if (u && verifyPassword(pw, u.password_hash)) user = u;
    }
    if (!user) {
      failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60000 });
      return loginPage(res, 'Wrong username or password.', 401);
    }
    failures.delete(ip);
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.set('Set-Cookie', `${COOKIE}=${user.id}.${exp}.${sign(user, exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
    res.redirect(user.role === 'admin' ? '/' : '/transactions');
  });
  app.post('/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(openMode() ? '/' : '/login');
  });

  app.use((req, res, next) => {
    const user = openMode() ? { ...ENV_ADMIN, name: 'Local (no password set)' } : sessionUser(req);
    if (!user) return req.method === 'GET' ? res.redirect('/login') : res.status(401).send('Log in first.');
    if (!allowed(user, req)) {
      if (req.method === 'GET' && req.path === '/') return res.redirect('/transactions');
      return res.status(403).send(layout({ title: 'No access', body: html`<h1>No access</h1><p>Your login can't open this page.</p><p><a href="/transactions">Go to Money in/out</a></p>`, user }));
    }
    res.locals.user = user;
    currentUser.run(user, next);
  });

  // Flash message via ?msg= / ?err= after a redirect.
  app.use((req, res, next) => {
    if (typeof req.query.msg === 'string') res.locals.flash = { type: 'ok', message: req.query.msg.slice(0, 200) };
    if (typeof req.query.err === 'string') res.locals.flash = { type: 'error', message: req.query.err.slice(0, 300) };
    next();
  });

  app.use('/', require('./features/reports')(db));
  app.use('/bookings', require('./features/bookings')(db));
  app.use('/import', require('./features/import')(db));
  app.use('/transactions', require('./features/transactions')(db));
  app.use('/settings', require('./features/settings')(db));
  app.use('/export', require('./features/exports')(db));

  app.use((req, res) => res.status(404).send(layout({ title: 'Not found', body: html`<h1>Not found</h1><p><a href="/">Back to start</a></p>` })));
  app.use((err, req, res, _next) => {
    console.error(err);
    const status = err.type === 'entity.too.large' ? 413 : 500;
    const msg = status === 413 ? 'That file is too big (limit 10 MB).' : err.message;
    res.status(status).send(layout({ title: 'Error', body: html`<h1>Something went wrong</h1><p class="muted">${msg}</p><p><a href="/">Back to start</a></p>` }));
  });

  return app;
}

module.exports = { createApp };
