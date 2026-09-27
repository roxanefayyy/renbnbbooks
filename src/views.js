// Shared page chrome and small UI helpers.
const { html, raw } = require('./html');
const { formatMoney } = require('./money');

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#0f6e5c;--accent-ink:#fff;--neg:#b3261e;--warn:#9a6700;--warn-bg:#fff4d6;--neg-bg:#fde8e6;--pos-bg:#e3f3ee}
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--accent)}
header{background:var(--ink);color:#fff;padding:0 16px}
header .inner{max-width:1200px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:4px 18px;min-height:52px}
header .brand{font-weight:700;letter-spacing:.2px;margin-right:8px;color:#fff;text-decoration:none}
header nav{display:flex;flex-wrap:wrap;gap:2px 14px}
header nav a{color:#d8d6cf;text-decoration:none;padding:6px 0;font-size:14px}
header nav a.on{color:#fff;border-bottom:2px solid #7fd1bd}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 10px}
.sub{color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.stat .label{color:var(--muted);font-size:13px}
.stat .value{font-size:22px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}
.stat .note{color:var(--muted);font-size:12px;margin-top:2px}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:600;background:#faf9f6}
td.num,th.num{text-align:right}
tr.total td{font-weight:650;border-top:2px solid var(--ink)}
tr.section td{background:#faf9f6;font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
tr:last-child td{border-bottom:0}
.neg{color:var(--neg)}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;background:var(--line)}
.pill.ok{background:var(--pos-bg);color:var(--accent)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.bad{background:var(--neg-bg);color:var(--neg)}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;background:var(--pos-bg);color:var(--accent)}
.flash.err{background:var(--neg-bg);color:var(--neg)}
.alert{padding:10px 14px;border-radius:8px;margin:0 0 10px;background:var(--warn-bg);color:var(--warn)}
.alert.bad{background:var(--neg-bg);color:var(--neg)}
form.stack{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));max-width:900px}
form.stack .full{grid-column:1/-1}
label{display:block;font-size:13px;color:var(--muted);font-weight:600}
input,select,textarea{display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid #cfccc4;border-radius:7px;font:inherit;background:#fff;color:var(--ink)}
input[type=checkbox]{display:inline;width:auto;margin:0 6px 0 0}
label.check{display:flex;align-items:center;color:var(--ink);font-weight:500;margin-top:24px}
.hint{font-weight:400;font-size:12px;color:var(--muted);margin-top:3px}
.btn,button{display:inline-block;padding:8px 14px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.ghost,button.ghost{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--neg);color:var(--neg)}
button.small,.btn.small{padding:3px 9px;font-size:13px}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:0 0 14px}
.toolbar form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.toolbar label{min-width:120px}
.toolbar .spacer{flex:1}
.inline{display:inline}
.row-actions{display:flex;gap:6px}
.login{max-width:340px;margin:12vh auto}
@media (max-width:600px){h1{font-size:19px}.stat .value{font-size:19px}}
`;

const NAV = [
  ['/', 'Dashboard'],
  ['/bookings', 'Bookings'],
  ['/transactions', 'Money in/out'],
  ['/reports/pnl', 'P&L'],
  ['/reports/trend', 'Trend'],
  ['/accounts', 'Accounts'],
  ['/settings', 'Settings'],
];

function layout({ title, active, body, flash, bare = false }) {
  const nav = NAV.map(([href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`);
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · RenBNB Books</title><style>${raw(CSS)}</style></head>
<body>
${bare ? '' : html`<header><div class="inner"><a class="brand" href="/">RenBNB Books</a><nav>${nav}</nav>
<span style="flex:1"></span><form method="post" action="/logout" class="inline"><button class="ghost small" style="color:#d8d6cf;border-color:#555">Log out</button></form></div></header>`}
<main>
${flash ? html`<div class="flash ${flash.type === 'error' ? 'err' : ''}">${flash.message}</div>` : ''}
${body}
</main></body></html>`.toString();
}

const money = (cents) => html`<span class="${cents < 0 ? 'neg' : ''}">${formatMoney(cents)}</span>`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function options(items, selected, { value = 'id', label = 'name', blank } = {}) {
  const sel = selected == null ? '' : String(selected);
  return html`${blank !== undefined ? html`<option value="">${blank}</option>` : ''}${items.map((it) =>
    html`<option value="${it[value]}" ${String(it[value]) === sel ? raw('selected') : ''}>${it[label]}</option>`)}`;
}

module.exports = { layout, money, pct, options };
