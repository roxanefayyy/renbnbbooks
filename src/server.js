const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb();
const app = createApp(db);
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`RenBNB Books running on http://localhost:${port} (db: ${db.file})`);
  if (!process.env.APP_PASSWORD) console.warn('WARNING: APP_PASSWORD is not set. Anyone who can reach this server can see your books.');
});
