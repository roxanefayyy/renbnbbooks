const express = require('express');
const crypto = require('node:crypto');
const { html } = require('./html');
const { layout } = require('./views');

const COOKIE = 'rb_session';
const SESSION_DAYS = 30;

function createApp(db, { password = process.env.APP_PASSWORD, secret = process.env.SESSION_SECRET } = {}) {
  const app = express();
  const key = secret || crypto.randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // --- auth: one shared team password, signed cookie ---
  const sign = (exp) => crypto.createHmac('sha256', key).update(`rb:${exp}`).digest('hex');
  const readCookie = (req) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const validSession = (req) => {
    const v = readCookie(req);
    if (!v) return false;
    const [exp, mac] = v.split('.');
    if (!exp || !mac || Number(exp) < Date.now()) return false;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const failures = new Map(); // ip -> { count, until }
  const loginPage = (res, error, status = 200) => res.status(status).send(layout({
    title: 'Log in',
    bare: true,
    body: html`<div class="login card"><h1>RenBNB Books</h1><p class="sub">Team password</p>
      ${error ? html`<div class="flash err">${error}</div>` : ''}
      <form method="post" action="/login"><label>Password<input type="password" name="password" autofocus required></label>
      <p><button>Log in</button></p></form></div>`,
  }));

  app.get('/login', (req, res) => (password ? loginPage(res) : res.redirect('/')));
  app.post('/login', (req, res) => {
    if (!password) return res.redirect('/');
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.count >= 5 && f.until > Date.now()) return loginPage(res, 'Too many attempts. Try again in 15 minutes.', 429);
    const given = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
    const want = crypto.createHash('sha256').update(password).digest();
    if (!crypto.timingSafeEqual(given, want)) {
      const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60000 };
      failures.set(ip, next);
      return loginPage(res, 'Wrong password.', 401);
    }
    failures.delete(ip);
    const exp = String(Date.now() + SESSION_DAYS * 86400000);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.set('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect(password ? '/login' : '/');
  });

  app.use((req, res, next) => {
    if (!password || validSession(req)) return next();
    if (req.method === 'GET') return res.redirect('/login');
    res.status(401).send('Log in first.');
  });

  // Flash message via ?msg= / ?err= after a redirect.
  app.use((req, res, next) => {
    if (typeof req.query.msg === 'string') res.locals.flash = { type: 'ok', message: req.query.msg.slice(0, 200) };
    if (typeof req.query.err === 'string') res.locals.flash = { type: 'error', message: req.query.err.slice(0, 300) };
    next();
  });

  app.use('/', require('./features/reports')(db));
  app.use('/bookings', require('./features/bookings')(db));
  app.use('/transactions', require('./features/transactions')(db));
  app.use('/settings', require('./features/settings')(db));
  app.use('/export', require('./features/exports')(db));

  app.use((req, res) => res.status(404).send(layout({ title: 'Not found', body: html`<h1>Not found</h1><p><a href="/">Back to dashboard</a></p>` })));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).send(layout({ title: 'Error', body: html`<h1>Something went wrong</h1><p class="muted">${err.message}</p><p><a href="/">Back to dashboard</a></p>` }));
  });

  return app;
}

module.exports = { createApp };
