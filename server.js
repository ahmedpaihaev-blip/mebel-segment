'use strict';
// Мебель Сегмент: магазин фурнитуры и кабинет владельца.
// Без внешних зависимостей: Node.js 22+ (http, crypto, node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const tls = require('node:tls');
// у многих VPS нет IPv6-связи: сначала пробуем IPv4, иначе запросы наружу (Telegram) обрываются
require('node:dns').setDefaultResultOrder('ipv4first');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14; // 14 дней

if (!ADMIN_PASSWORD) console.warn('ВНИМАНИЕ: ADMIN_PASSWORD не задан, вход в кабинет невозможен.');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'shop.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, cat TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'шт', price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS banks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, acc TEXT NOT NULL DEFAULT '', balance REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS txns (id INTEGER PRIMARY KEY, date TEXT NOT NULL, bank_id INTEGER NOT NULL REFERENCES banks(id), text TEXT NOT NULL, amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, date TEXT NOT NULL, client TEXT NOT NULL, phone TEXT NOT NULL, inn TEXT, comment TEXT, status TEXT NOT NULL DEFAULT 'new');
CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, date TEXT NOT NULL, client TEXT NOT NULL, inn TEXT, status TEXT NOT NULL DEFAULT 'issued',
  paid_bank INTEGER REFERENCES banks(id), shipped INTEGER NOT NULL DEFAULT 0, order_id INTEGER REFERENCES orders(id));
CREATE TABLE IF NOT EXISTS invoice_items (invoice_id INTEGER NOT NULL REFERENCES invoices(id), product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY, date TEXT NOT NULL, supplier TEXT NOT NULL, bank_id INTEGER REFERENCES banks(id));
CREATE TABLE IF NOT EXISTS receipt_items (receipt_id INTEGER NOT NULL REFERENCES receipts(id), product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', inn TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL, customer_id INTEGER, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, amount REAL NOT NULL,
  status TEXT NOT NULL, created TEXT NOT NULL, url TEXT);
CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL, payment_id TEXT, amount REAL NOT NULL, status TEXT NOT NULL,
  created TEXT NOT NULL, reason TEXT, bank_id INTEGER);
`);
for (const [table, col, type] of [['products', 'photo', 'TEXT'], ['products', 'box', 'INTEGER'], ['products', 'descr', 'TEXT'], ['orders', 'customer_id', 'INTEGER'], ['invoices', 'email', 'TEXT'], ['invoices', 'shipped_at', 'TEXT'], ['txns', 'ext_id', 'TEXT'],
  ['orders', 'consent', 'TEXT'], ['customers', 'consent', 'TEXT']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS txns_ext ON txns (bank_id, ext_id) WHERE ext_id IS NOT NULL');
const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

if (!db.prepare('SELECT COUNT(*) c FROM banks').get().c) {
  const ins = db.prepare('INSERT INTO banks (name, acc, balance) VALUES (?, ?, 0)');
  for (const n of ['Альфа-Банк', 'Сбербанк', 'Россельхозбанк']) ins.run(n, '');
}
const DEFAULT_OWNER = { name: '', inn: '', ogrnip: '', addr: '', bank: '', acc: '', bik: '', ks: '', phone: '', email: '' };
const getOwner = () => {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'owner'").get();
  return { ...DEFAULT_OWNER, ...(r ? JSON.parse(r.value) : {}) };
};
const CATS = ['Петли', 'Направляющие', 'Ручки', 'Подъёмники', 'Опоры', 'Упаковка', 'Прочее'];

// Каталог из КП (catalog/catalog.json): загружается один раз на каждую новую версию файла.
// Товары, уже изменённые владельцем, не перезаписываются — добавляются только новые артикулы.
(function importCatalog() {
  const dir = path.join(__dirname, 'catalog');
  let cat; try { cat = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')); } catch { return; }
  const done = Number(db.prepare("SELECT value FROM settings WHERE key = 'catalog_version'").get()?.value || 0);
  if (done >= cat.version) return;
  db.exec('BEGIN');
  try {
    const hide = db.prepare('UPDATE products SET active = 0 WHERE sku = ?');
    for (const sku of cat.replaceSkus || []) hide.run(sku);
    const exists = db.prepare('SELECT id FROM products WHERE sku = ?');
    const ins = db.prepare('INSERT INTO products (sku, name, cat, unit, price, stock, box, descr) VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
    const setPhoto = db.prepare('UPDATE products SET photo = ? WHERE id = ?');
    for (const p of cat.products) {
      if (exists.get(p.sku)) continue;
      const id = Number(ins.run(p.sku, p.name, CATS.includes(p.cat) ? p.cat : 'Прочее', p.unit || 'шт', p.price, p.box || null, p.descr || null).lastInsertRowid);
      if (p.photo) {
        const name = `${id}-${crypto.randomBytes(6).toString('hex')}.jpg`;
        fs.copyFileSync(path.join(dir, 'photos', path.basename(p.photo)), path.join(UPLOADS, name));
        setPhoto.run(name, id);
      }
    }
    if (cat.owner) {
      const o = getOwner();
      for (const k of Object.keys(cat.owner)) if (!o[k]) o[k] = cat.owner[k];
      db.prepare("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(o));
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('catalog_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(cat.version));
    db.exec('COMMIT');
    console.log(`Каталог v${cat.version} загружен.`);
  } catch (e) { db.exec('ROLLBACK'); console.error('Не удалось загрузить каталог:', e); }
})();

const now = () => new Date().toISOString();
const r2 = n => Math.round(n * 100) / 100;

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const posInt = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
const money = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? r2(n) : NaN; };

/* ---------- сессии ---------- */
// сессии хранятся в базе (в виде хеша токена), чтобы переживать обновления сайта
const loginFails = new Map();
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function newSession(res, req, kind, customerId = null) {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, kind, customer_id, exp) VALUES (?, ?, ?, ?)').run(tokenHash(t), kind, customerId, Date.now() + SESSION_TTL);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${kind === 'admin' ? 'sid' : 'cid'}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
}
function endSession(req, res, kind) {
  const name = kind === 'admin' ? 'sid' : 'cid', t = cookies(req)[name];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(t));
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function sessionOf(req, kind) {
  const t = cookies(req)[kind === 'admin' ? 'sid' : 'cid'];
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ?').get(tokenHash(t), kind);
  return s && s.exp > Date.now() ? s : null;
}
function tooMany(req, key) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const k = key + ip, f = loginFails.get(k) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new UserError('Слишком много попыток. Подождите 10 минут.', 429);
  return { fail() { f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; } loginFails.set(k, f); }, ok() { loginFails.delete(k); } };
}
// пароли клиентов: scrypt с солью
function hashPass(pw) { const salt = crypto.randomBytes(16); return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPass(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
}
const digits = v => String(v || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
const normEmail = v => str(v, 160).toLowerCase();
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
// привязать заказы, оформленные без входа, к клиенту по номеру телефона
function linkOrders(c) {
  const d = digits(c.phone); if (d.length < 10) return;
  const free = db.prepare('SELECT id, phone FROM orders WHERE customer_id IS NULL').all();
  const upd = db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?');
  for (const o of free) if (digits(o.phone) === d) upd.run(c.id, o.id);
}
const publicCustomer = c => ({ id: c.id, email: c.email, name: c.name, phone: c.phone, company: c.company, inn: c.inn, created: c.created });
function customerOf(req) { const s = sessionOf(req, 'customer'); return s ? db.prepare('SELECT * FROM customers WHERE id = ?').get(s.customer_id) || null : null; }
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAdmin(req) { return !!sessionOf(req, 'admin'); }
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest(), hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- данные ---------- */
function invoiceRows(where = '', ...args) {
  const invs = db.prepare(`SELECT * FROM invoices ${where} ORDER BY id DESC`).all(...args);
  const items = db.prepare('SELECT ii.*, p.sku, p.name, p.unit FROM invoice_items ii JOIN products p ON p.id = ii.product_id WHERE invoice_id = ?');
  return invs.map(i => { const it = items.all(i.id); return { ...i, items: it, sum: r2(it.reduce((s, x) => s + x.qty * x.price, 0)) }; });
}
function adminState() {
  const recItems = db.prepare('SELECT ri.*, p.sku, p.name FROM receipt_items ri JOIN products p ON p.id = ri.product_id WHERE receipt_id = ?');
  return {
    owner: getOwner(),
    yk: (y => y ? { shop_id: y.shop_id, test: !!y.test, bank: y.bank, receipt: !!y.receipt, tax: y.tax || 0, vat: y.vat || 1 } : null)(ykCfg()),
    mail: (m => m ? { host: m.host, port: m.port, user: m.user, to: m.to || '', ok: !!m.pass } : null)(getSetting('mail')),
    tg: (t => t ? { bot: t.bot || '', linked: !!t.chat_id, chat: t.chat_name || '' } : null)(getSetting('tg')),
    cats: CATS,
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all(),
    banks: db.prepare('SELECT * FROM banks ORDER BY id').all(),
    txns: db.prepare('SELECT * FROM txns ORDER BY id DESC LIMIT 300').all(),
    invoices: (paidOnline => invoiceRows().map(i => ({ ...i, links: docLinks(i), online: paidOnline.has(i.id) })))(
      new Set(db.prepare("SELECT invoice_id FROM payments WHERE status = 'succeeded'").all().map(r => r.invoice_id))),
    docs: docsCfg(), seo: seoCfg(),
    backup: { ...backupCfg(), last: getSetting('backup_last') },
    orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all(),
    customers: db.prepare(`SELECT c.id, c.email, c.name, c.phone, c.company, c.inn, c.created,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS orders,
        (SELECT COALESCE(SUM(ii.qty * ii.price), 0) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN orders o ON o.id = i.order_id
          WHERE o.customer_id = c.id AND i.status NOT IN ('cancelled', 'refunded')) AS total,
        (SELECT COALESCE(SUM(ii.qty * ii.price), 0) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN orders o ON o.id = i.order_id
          WHERE o.customer_id = c.id AND i.status = 'paid') AS paid
      FROM customers c ORDER BY total DESC, c.id DESC`).all(),
    receipts: db.prepare('SELECT * FROM receipts ORDER BY id DESC LIMIT 300').all()
      .map(r => { const it = recItems.all(r.id); return { ...r, items: it, sum: r2(it.reduce((s, x) => s + x.qty * x.cost, 0)) }; }),
  };
}
function readItems(list, withCost) {
  if (!Array.isArray(list) || !list.length || list.length > 100) throw new UserError('Добавьте хотя бы одну позицию.');
  const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  return list.map(x => {
    const p = getP.get(posInt(x.pid)); const qty = posInt(x.qty);
    if (!p) throw new UserError('Товар не найден. Обновите страницу.');
    if (!qty) throw new UserError(`Укажите количество для «${p.name}».`);
    const out = { p, qty };
    if (withCost) { out.cost = money(x.cost); if (Number.isNaN(out.cost)) throw new UserError(`Укажите цену закупки для «${p.name}».`); }
    return out;
  });
}
function createInvoice({ client, inn, items, orderId }) {
  const inv = db.prepare('INSERT INTO invoices (date, client, inn, order_id) VALUES (?, ?, ?, ?)').run(now(), client, inn || null, orderId ?? null);
  const ins = db.prepare('INSERT INTO invoice_items (invoice_id, product_id, qty, price) VALUES (?, ?, ?, ?)');
  for (const x of items) ins.run(inv.lastInsertRowid, x.p.id, x.qty, x.p.price);
  return Number(inv.lastInsertRowid);
}



/* ---------- почта (SMTP через SSL, порт 465) ---------- */
function smtpSend({ host, port, user, pass }, to, subject, html, files = []) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: Number(port) || 465, servername: host, rejectUnauthorized: process.env.SMTP_TEST_INSECURE !== '1' });
    let buf = '', step = 0, done = false;
    const fail = e => { if (done) return; done = true; sock.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    const timer = setTimeout(() => fail(new Error('почтовый сервер не отвечает')), 20000);
    const b64 = v => Buffer.from(v, 'utf8').toString('base64');
    const wrap76 = v => v.replace(/.{76}/g, '$&\r\n');
    const body = wrap76(b64(html));
    const bnd = 'ms_' + crypto.randomBytes(8).toString('hex');
    const msg = [`From: =?UTF-8?B?${b64('Mebel Segment')}?= <${user}>`, `To: <${to}>`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${user.split('@')[1] || 'mebel-segment.ru'}>`,
      'MIME-Version: 1.0', ...(files.length ? [
        `Content-Type: multipart/mixed; boundary="${bnd}"`, '', `--${bnd}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
        ...files.flatMap(f => [`--${bnd}`, `Content-Type: ${f.type || 'application/octet-stream'}; name="${f.name}"`, 'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${f.name}"`, '', wrap76(f.content.toString('base64'))]), `--${bnd}--`]
        : ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body]), '.'].join('\r\n');
    const script = [
      [220, `EHLO mebel-segment.ru`], [250, 'AUTH LOGIN'], [334, b64(user)], [334, b64(pass)],
      [235, `MAIL FROM:<${user}>`], [250, `RCPT TO:<${to}>`], [250, 'DATA'], [354, msg], [250, 'QUIT']];
    sock.setEncoding('utf8');
    sock.on('error', e => fail(new Error(e.code === 'ENOTFOUND' ? 'не найден почтовый сервер ' + host : e.message)));
    sock.on('data', d => {
      buf += d;
      let m; while ((m = buf.match(/^(\d{3})([ -])(.*)\r?\n/m))) {
        buf = buf.slice(m.index + m[0].length);
        if (m[2] === '-') continue;
        const code = Number(m[1]), [want, send] = script[step] || [];
        if (want === undefined) { clearTimeout(timer); done = true; sock.end(); return resolve(); }
        if (code !== want) {
          clearTimeout(timer);
          return fail(new Error((code === 535 || code === 534 ? 'почта не приняла логин или пароль (нужен пароль приложения, не обычный пароль)' : 'почтовый сервер отказал') + `. Ответ сервера: «${code} ${m[3].slice(0, 160)}»`));
        }
        step++; sock.write(send + '\r\n');
      }
    });
  });
}
const mailCfg = () => { const m = getSetting('mail'); return m && m.host && m.user && m.pass ? m : null; };
async function mailTo(to, subject, html, files) { const m = mailCfg(); if (!m) return false; await smtpSend(m, to, subject, html, files); return true; }
const mailWrap = (title, inner, btn) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#151515">
  <div style="background:#1B1B1B;color:#EDECE8;padding:18px 22px;border-radius:14px 14px 0 0;font-weight:bold;letter-spacing:.06em">MEBEL SEGMENT</div>
  <div style="background:#fff;border:1px solid #e3e1dc;border-top:0;padding:22px;border-radius:0 0 14px 14px;line-height:1.5">
  <h2 style="margin:0 0 12px;font-size:20px">${title}</h2>${inner}
  ${btn ? `<p style="margin:22px 0 0"><a href="${btn.url}" style="background:#151515;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:bold;display:inline-block">${btn.text}</a></p>` : ''}
  </div><p style="color:#8a8984;font-size:12px;text-align:center">mebel-segment.ru</p></div>`;

/* ---------- уведомления в Telegram ---------- */
const SITE_URL = process.env.SITE_URL || 'https://mebel-segment.ru';
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));
const h = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hq = v => h(v).replace(/"/g, '&quot;');
// Яндекс Метрика и Вебмастер: номер счётчика и код подтверждения задаются в кабинете («Настройки» → «Сайт в Яндексе»)
const seoCfg = () => ({ metrika: '', ywm: '', ...(getSetting('seo') || {}) });
const seoHead = () => { const c = seoCfg(); return c.ywm ? `<meta name="yandex-verification" content="${hq(c.ywm)}">` : ''; };
function metrikaTag() {
  const id = seoCfg().metrika; if (!/^\d{5,12}$/.test(id)) return '';
  return `<script>(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();
for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r)return}k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${id},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,ecommerce:"dataLayer"});window.MS_METRIKA=${id};</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${id}" style="position:absolute;left:-9999px" alt=""></div></noscript>
<script>(function(){try{if(localStorage.getItem('cookieOk'))return}catch(e){}var d=document.createElement('div');
d.style.cssText='position:fixed;left:12px;right:12px;bottom:12px;z-index:40;max-width:560px;margin:0 auto;background:#151515;color:#EDECE8;border-radius:16px;padding:14px 16px;font:13px/1.45 Arial,sans-serif;display:flex;gap:12px;align-items:center';
d.innerHTML='<span style="flex:1">Мы используем cookie и Яндекс Метрику, чтобы сайт работал и становился удобнее. Подробнее — в <a href="/privacy" style="color:#EDECE8">политике конфиденциальности</a>.</span><button style="border:0;background:#EDECE8;color:#151515;font-weight:bold;border-radius:999px;padding:9px 16px;cursor:pointer">Хорошо</button>';
d.querySelector('button').onclick=function(){try{localStorage.setItem('cookieOk','1')}catch(e){}d.remove()};addEventListener('load',function(){document.body.appendChild(d)})})()</script>`;
}
const rubs = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';
async function tgCall(token, method, body) {
  let r;
  try { r = await fetch(`${process.env.TG_API || 'https://api.telegram.org'}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000) }); }
  catch (e) {
    const why = e.name === 'TimeoutError' ? 'нет ответа 10 секунд' : (e.cause && (e.cause.code || e.cause.message)) || e.message;
    console.error('Telegram недоступен:', why);
    throw new Error(`сервер сайта не может связаться с Telegram (${why}). Возможно, провайдер сервера блокирует api.telegram.org`);
  }
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `Telegram ответил ${r.status}`);
  return j.result;
}
async function tgSend(text, link) {
  const t = getSetting('tg');
  if (!t || !t.token || !t.chat_id) return false;
  await tgCall(t.token, 'sendMessage', { chat_id: t.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: link ? { inline_keyboard: [[{ text: link.text, url: link.url }]] } : undefined });
  return true;
}
// уведомление владельцу: в Telegram (если подключён) и на почту (если подключена)
function notify(text, link, subject) {
  tgSend(text, link).catch(e => console.error('Telegram:', e.message));
  const m = mailCfg();
  if (m && m.to) {
    const [first, ...rest] = text.split('\n');
    mailTo(m.to, subject || first.replace(/<[^>]+>/g, ''), mailWrap(first.replace(/^\S+\s/, ''), `<p style="margin:0">${rest.join('<br>')}</p>`, link))
      .catch(e => console.error('Почта:', e.message));
  }
}
function notifyOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId); if (!o) return;
  const [inv] = invoiceRows('WHERE order_id = ?', o.id);
  const c = o.customer_id ? db.prepare('SELECT email FROM customers WHERE id = ?').get(o.customer_id) : null;
  const lines = (inv ? inv.items : []).map(x => `• ${h(x.name)} — ${x.qty} ${h(x.unit)} × ${rubs(x.price)}`);
  const head = [`🛒 <b>Новый заказ №${o.id}</b> — <b>${rubs(inv ? inv.sum : 0)}</b>`, `👤 ${h(o.client)}${c ? ` (кабинет: ${h(c.email)})` : ''}`,
    `📞 ${h(o.phone)}`, o.inn ? `🏢 ИНН ${h(o.inn)}` : '', o.comment ? `💬 ${h(o.comment)}` : ''].filter(Boolean);
  notify([head.join('\n'), lines.join('\n'), inv ? `Счёт №${inv.id} выставлен автоматически.` : ''].filter(Boolean).join('\n\n'), { text: 'Открыть в кабинете', url: SITE_URL + '/admin' }, `Новый заказ №${o.id} на ${rubs(inv ? inv.sum : 0)} — ${o.client}`);
}


/* ---------- онлайн-оплата: ЮKassa ---------- */
const ykCfg = () => { const y = getSetting('yk'); return y && y.shop_id && y.secret ? y : null; };
async function ykApi(cfg, method, pth, body) {
  let r;
  try {
    r = await fetch(`${process.env.YK_API || 'https://api.yookassa.ru'}/v3${pth}`, { method, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.shop_id}:${cfg.secret}`).toString('base64'), 'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotence-Key': crypto.randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error('нет связи с ЮKassa (' + ((e.cause && e.cause.code) || e.message) + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'ЮKassa не приняла shopId или секретный ключ' : (j.description || `ЮKassa ответила ${r.status}`));
  return j;
}
// телефон для чека: 11 цифр, начиная с 7 (9001234567 → 79001234567)
const phone11 = v => { const d = digits(v); return d.length === 10 ? '7' + d : d.length === 11 && d[0] === '7' ? d : ''; };
// данные для чека по 54-ФЗ («Чеки от ЮKassa» или подключённая касса). Тот же состав — для чека возврата.
function receiptFor(cfg, inv, o, c) {
  const email = (c && c.email) || inv.email || '', ph = phone11(o && o.phone);
  const customer = validEmail(email) ? { email } : ph ? { phone: ph } : null;
  if (!customer) throw new UserError('Для кассового чека нужна почта или телефон покупателя.');
  const r = { customer, items: inv.items.map(x => ({ description: x.name.slice(0, 128), quantity: String(x.qty), amount: { value: x.price.toFixed(2), currency: 'RUB' },
    vat_code: Number(cfg.vat) || 1, payment_mode: 'full_payment', payment_subject: 'commodity' })) };
  if (Number(cfg.tax)) r.tax_system_code = Number(cfg.tax);
  return r;
}
async function startPayment(invoiceId) {
  const cfg = ykCfg(); if (!cfg) throw new UserError('Онлайн-оплата пока не подключена. Оплатите по счёту.');
  const [inv] = invoiceRows('WHERE id = ?', invoiceId);
  if (!inv) throw new UserError('Счёт не найден.', 404);
  if (inv.status !== 'issued') throw new UserError(inv.status === 'paid' ? 'Этот заказ уже оплачен.' : inv.status === 'refunded' ? 'По этому заказу деньги возвращены.' : 'Этот счёт отменён.');
  const o = inv.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(inv.order_id) : null;
  const c = o && o.customer_id ? db.prepare('SELECT email FROM customers WHERE id = ?').get(o.customer_id) : null;
  const token = crypto.randomBytes(16).toString('hex');
  const body = {
    amount: { value: inv.sum.toFixed(2), currency: 'RUB' }, capture: true,
    confirmation: { type: 'redirect', return_url: `${SITE_URL}/?pay=${token}` },
    description: `Заказ №${o ? o.id : inv.id} на mebel-segment.ru`.slice(0, 128),
    metadata: { invoice_id: String(inv.id), order_id: String(o ? o.id : '') },
  };
  if (cfg.receipt) body.receipt = receiptFor(cfg, inv, o, c);
  const p = await ykApi(cfg, 'POST', '/payments', body);
  const url = p.confirmation && p.confirmation.confirmation_url;
  if (!url) throw new Error('ЮKassa не вернула ссылку на оплату');
  db.prepare('INSERT INTO payments (id, invoice_id, token, amount, status, created, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id, inv.id, token, inv.sum, p.status, now(), url);
  return url;
}
// статус всегда берём у самой ЮKassa: уведомлению без проверки не доверяем
async function syncPayment(id) {
  const cfg = ykCfg(); const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(String(id));
  if (!cfg || !row) return null;
  const p = await ykApi(cfg, 'GET', '/payments/' + encodeURIComponent(row.id));
  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(p.status, row.id);
  if (p.status === 'succeeded' && p.paid) {
    const done = tx(() => {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.invoice_id);
      if (!inv || inv.status !== 'issued') return null;
      const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(cfg.bank) || db.prepare('SELECT * FROM banks ORDER BY id LIMIT 1').get();
      const amount = r2(Number(p.amount.value));
      db.prepare("UPDATE invoices SET status = 'paid', paid_bank = ? WHERE id = ?").run(bank ? bank.id : null, inv.id);
      if (bank) {
        db.prepare('UPDATE banks SET balance = round(balance + ?, 2) WHERE id = ?').run(amount, bank.id);
        db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id, `Онлайн-оплата ЮKassa по счёту №${inv.id}, ${inv.client}`, amount);
      }
      return { inv, amount };
    });
    if (done) notify(`💳 <b>Оплачен онлайн заказ${done.inv.order_id ? ' №' + done.inv.order_id : ''}</b> — <b>${rubs(done.amount)}</b>\n👤 ${h(done.inv.client)}\nСчёт №${done.inv.id} отмечен оплаченным.`,
      { text: 'Открыть в кабинете', url: SITE_URL + '/admin' }, `Оплачен онлайн: ${rubs(done.amount)} — ${done.inv.client}`);
  }
  return p.status;
}


/* ---------- общие страницы сайта (реквизиты, политика, товары) ---------- */
const PRIVACY_DATE = '18.11.2026';
const INFO_CSS = `*{box-sizing:border-box}body{margin:0;background:#E8E7E3;color:#151515;font:15px/1.6 Arial,Helvetica,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:16px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0 20px}
header img{height:34px}header a{color:#151515;font-weight:bold;text-decoration:none;font-size:14px}
.card{background:#fff;border-radius:18px;padding:24px 28px;margin-bottom:14px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:0 0 10px}
table{border-collapse:collapse;width:100%}td{padding:7px 0;border-bottom:1px solid #eee;vertical-align:top}td:first-child{color:#666;width:200px;padding-right:12px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}nav a{border:1.5px solid #151515;border-radius:999px;padding:5px 14px;color:#151515;text-decoration:none;font-size:13px;font-weight:bold}
ol,ul{padding-left:20px}li{margin:4px 0}.muted{color:#666;font-size:13px}@media(max-width:600px){td:first-child{width:120px}.card{padding:18px}}
a{color:#151515}`;
function pageShell(title, desc, canon, extraHead = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} — Mebel Segment</title><meta name="description" content="${hq(desc)}"><link rel="canonical" href="${SITE_URL}${canon}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Mebel Segment"><meta property="og:title" content="${hq(title)}"><meta property="og:description" content="${hq(desc)}">
<link rel="icon" href="/favicon.png">${seoHead()}${extraHead}<style>${INFO_CSS}</style></head><body><div class="wrap">
<header><a href="/"><img src="/logo.png" alt="Mebel Segment"></a><a href="/#catalog">← В каталог</a></header>
`;
}
const pageEnd = () => `<p class="muted" style="text-align:center"><a href="/rekvizity">Реквизиты и оферта</a> · <a href="/privacy">Политика конфиденциальности</a> · <a href="/soglasie">Согласие на обработку данных</a></p>
</div>${metrikaTag()}</body></html>`;
/* ---------- страница «Реквизиты и условия» (требуется ЮKassa и банками) ---------- */
function renderInfo() {
  const o = getOwner(), e = v => h(v || '');
  const req = [['Продавец', o.name || 'Индивидуальный предприниматель'], ['ИНН', o.inn], ['ОГРНИП', o.ogrnip], ['Адрес', o.addr],
    ['Телефон', o.phone], ['Почта', o.email], ['Расчётный счёт', o.acc], ['Банк', o.bank], ['БИК', o.bik], ['Корр. счёт', o.ks]].filter(([, v]) => v);
  return pageShell('Реквизиты и условия', 'Реквизиты продавца, условия оплаты, доставки и возврата, публичная оферта Mebel Segment.', '/rekvizity') + `<div class="card"><h1>Реквизиты и условия</h1><p class="muted">Интернет-магазин мебельной фурнитуры mebel-segment.ru</p>
<nav><a href="#rekvizity">Реквизиты</a><a href="#oplata">Оплата</a><a href="#dostavka">Доставка</a><a href="#vozvrat">Возврат</a><a href="#oferta">Оферта</a><a href="#dannye">Персональные данные</a></nav></div>
<div class="card" id="rekvizity"><h2>Реквизиты продавца</h2><table>${req.map(([k, v]) => `<tr><td>${k}</td><td>${e(v)}</td></tr>`).join('')}</table></div>
<div class="card" id="oplata"><h2>Оплата</h2><ul>
<li><b>По счёту</b> — для организаций и ИП: безналичный перевод на расчётный счёт продавца. Счёт выставляется после оформления заказа.</li>
<li><b>Онлайн на сайте</b> — банковской картой (Мир, Visa, Mastercard), через СБП или SberPay. Платёж проходит на защищённой странице платёжного сервиса ЮKassa; данные карты продавцу не передаются.</li>
<li>Цены указаны в рублях, НДС не облагается (продавец применяет УСН). Кассовый чек направляется покупателю на почту или телефон.</li></ul></div>
<div class="card" id="dostavka"><h2>Доставка и самовывоз</h2><ul>
<li><b>Самовывоз</b> — ${e(o.addr || 'г. Ставрополь')}, по предварительному согласованию по телефону ${e(o.phone)}.</li>
<li><b>Доставка</b> по Ставрополю и в другие города России — транспортными компаниями или курьером. Стоимость и срок рассчитываются индивидуально и согласовываются с покупателем до отправки.</li>
<li>Товар отгружается после подтверждения заказа и оплаты. Позиции «под заказ» — в срок, согласованный с менеджером.</li></ul></div>
<div class="card" id="vozvrat"><h2>Обмен и возврат</h2><ul>
<li>Товар надлежащего качества, купленный дистанционно, покупатель-гражданин вправе вернуть в течение 7 дней после получения, если сохранены его товарный вид и потребительские свойства (ст. 26.1 Закона «О защите прав потребителей»).</li>
<li>При обнаружении брака продавец заменяет товар или возвращает деньги в соответствии с законодательством РФ.</li>
<li>Деньги возвращаются тем же способом, которым была произведена оплата, в течение 10 дней с момента получения требования.</li>
<li>Для возврата свяжитесь с нами: ${e(o.phone)}${o.email ? ', ' + e(o.email) : ''}.</li></ul>
<p class="muted">Для покупателей — юридических лиц и ИП условия возврата определяются договором поставки и Гражданским кодексом РФ.</p></div>
<div class="card" id="oferta"><h2>Публичная оферта</h2><ol>
<li>Настоящий документ — предложение ${e(o.name || 'продавца')}${o.inn ? ', ИНН ' + e(o.inn) : ''}${o.ogrnip ? ', ОГРНИП ' + e(o.ogrnip) : ''} (далее — Продавец) заключить договор купли-продажи товаров, представленных на сайте mebel-segment.ru, на изложенных ниже условиях.</li>
<li>Акцептом оферты является оформление заказа на сайте или оплата выставленного счёта. С момента акцепта договор считается заключённым.</li>
<li>Наименование, количество и цена товара указываются в заказе и счёте. Цена фиксируется в момент оформления заказа; наличие и сроки подтверждаются Продавцом.</li>
<li>Оплата производится способами, указанными в разделе «Оплата». Обязанность Продавца по передаче товара возникает после поступления оплаты, если иное не согласовано.</li>
<li>Право собственности и риск случайной гибели переходят к Покупателю в момент передачи товара Покупателю или перевозчику.</li>
<li>Обмен и возврат — в соответствии с разделом «Обмен и возврат» и законодательством РФ.</li>
<li>Споры разрешаются путём переговоров, при недостижении согласия — в порядке, установленном законодательством РФ.</li></ol></div>
<div class="card" id="dannye"><h2>Персональные данные</h2>
<p>Как мы обрабатываем и защищаем данные покупателей — в <a href="/privacy">Политике обработки персональных данных</a>. Текст согласия, которое покупатель даёт при заказе или регистрации, — на странице <a href="/soglasie">«Согласие на обработку персональных данных»</a>.</p></div>
<p class="muted" style="text-align:center">© ${new Date().getFullYear()} ${e(o.name || 'Mebel Segment')} · mebel-segment.ru</p>
` + pageEnd();
}
function operatorLine(o) {
  return [o.name || 'Индивидуальный предприниматель', o.inn && 'ИНН ' + o.inn, o.ogrnip && 'ОГРНИП ' + o.ogrnip, o.addr && 'адрес: ' + o.addr].filter(Boolean).map(h).join(', ');
}
function renderPrivacy() {
  const o = getOwner(), mail = o.email ? `<a href="mailto:${hq(o.email)}">${h(o.email)}</a>` : 'по телефону ' + h(o.phone || '');
  return pageShell('Политика обработки персональных данных', 'Как Mebel Segment обрабатывает и защищает персональные данные покупателей сайта mebel-segment.ru.', '/privacy') + `
<div class="card"><h1>Политика обработки персональных данных</h1><p class="muted">Редакция от ${PRIVACY_DATE}. Сайт mebel-segment.ru</p></div>
<div class="card"><h2>1. Кто обрабатывает данные</h2><p>Оператор персональных данных — ${operatorLine(o)} (далее — Оператор). Связаться с Оператором по вопросам персональных данных: ${mail}${o.phone && o.email ? ', тел. ' + h(o.phone) : ''}.</p>
<p>Политика составлена в соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных» и действует в отношении всех данных, которые Оператор получает от посетителей сайта.</p></div>
<div class="card"><h2>2. Какие данные мы обрабатываем и зачем</h2><table>
<tr><td>Оформление и исполнение заказа, выставление счёта и документов, связь по заказу</td><td>имя или наименование организации, телефон, адрес электронной почты, ИНН (для организаций и ИП), адрес доставки, состав заказа и комментарий</td></tr>
<tr><td>Личный кабинет покупателя</td><td>почта, имя, телефон, организация, ИНН, пароль (хранится только в виде необратимого хеша), история заказов</td></tr>
<tr><td>Онлайн-оплата и кассовый чек</td><td>почта или телефон для чека, сумма и состав заказа. Данные банковской карты вводятся на странице платёжного сервиса и Оператору не передаются</td></tr>
<tr><td>Безопасность сайта</td><td>IP-адрес, технические данные запросов (журналы сервера), файлы cookie сеанса входа</td></tr>
${seoCfg().metrika ? '<tr><td>Статистика посещаемости и улучшение сайта</td><td>сведения о посещениях, собираемые сервисом Яндекс Метрика: обезличенный идентификатор, IP-адрес, сведения о браузере и устройстве, просмотренные страницы</td></tr>' : ''}
</table><p>Оператор не обрабатывает специальные категории и биометрические персональные данные.</p></div>
<div class="card"><h2>3. Основания обработки</h2><ul><li>согласие покупателя на обработку персональных данных — <a href="/soglasie">текст согласия</a>;</li>
<li>заключение и исполнение договора купли-продажи, стороной которого является покупатель (<a href="/rekvizity#oferta">публичная оферта</a>);</li>
<li>исполнение обязанностей Оператора по налоговому и бухгалтерскому учёту и законодательству о применении контрольно-кассовой техники.</li></ul></div>
<div class="card"><h2>4. Что мы делаем с данными</h2><p>Сбор, запись, систематизация, накопление, хранение, уточнение, использование, передача (предоставление) в случаях из раздела 5, обезличивание, блокирование, удаление и уничтожение — с использованием средств автоматизации и без них.</p>
<p>Запись и хранение персональных данных граждан РФ ведутся в базах данных, находящихся на территории Российской Федерации.</p></div>
<div class="card"><h2>5. Кому передаются данные</h2><ul>
<li>платёжному сервису ЮKassa (ООО НКО «ЮМани») — для приёма онлайн-оплаты и формирования кассового чека;</li>
<li>службам доставки и перевозчикам — имя, телефон и адрес, если выбрана доставка;</li>
<li>почтовому сервису, через который отправляются письма со счётом, накладной и восстановлением пароля;</li>
${seoCfg().metrika ? '<li>ООО «Яндекс» — сведения о посещениях через сервис Яндекс Метрика;</li>' : ''}
<li>государственным органам — в случаях, прямо предусмотренных законом.</li></ul>
<p>Оператор не продаёт персональные данные и не передаёт их для рекламы третьих лиц.</p></div>
<div class="card"><h2>6. Сроки хранения</h2><p>Данные хранятся до достижения целей обработки или до отзыва согласия. Сведения в счетах, накладных и кассовых документах хранятся в течение сроков, установленных законодательством о бухгалтерском и налоговом учёте (как правило, 5 лет). По истечении сроков данные удаляются или обезличиваются.</p></div>
<div class="card"><h2>7. Как мы защищаем данные</h2><ul><li>соединение с сайтом защищено шифрованием (HTTPS);</li><li>пароли покупателей хранятся только в виде криптографического хеша;</li>
<li>доступ к данным заказов есть только у Оператора, вход в кабинет защищён паролем и ограничением числа попыток;</li><li>ссылки на счета и накладные содержат секретный ключ и не подбираются перебором;</li><li>регулярно создаются резервные копии.</li></ul></div>
<div class="card"><h2>8. Ваши права</h2><p>Вы вправе получить сведения об обработке своих данных, потребовать их уточнения, блокирования или удаления, отозвать согласие, а также обжаловать действия Оператора в Роскомнадзоре или в суде. Направьте запрос ${mail}. Оператор ответит в течение 10 рабочих дней.</p>
<p>Отзыв согласия не влияет на законность обработки до отзыва. После отзыва Оператор вправе продолжить обработку, если это необходимо для исполнения уже заключённого договора или требований закона.</p></div>
<div class="card"><h2>9. Cookie</h2><p>Сайт использует cookie, необходимые для работы корзины и входа в личный кабинет${seoCfg().metrika ? ', а также cookie сервиса Яндекс Метрика для статистики посещений. Отключить cookie можно в настройках браузера; без них корзина и вход могут работать некорректно' : ''}.</p></div>
` + pageEnd();
}
function renderConsent() {
  const o = getOwner();
  return pageShell('Согласие на обработку персональных данных', 'Текст согласия покупателя на обработку персональных данных при оформлении заказа и регистрации на mebel-segment.ru.', '/soglasie') + `
<div class="card"><h1>Согласие на обработку персональных данных</h1><p class="muted">Редакция от ${PRIVACY_DATE}</p>
<p>Отмечая на сайте mebel-segment.ru поле «Я даю согласие на обработку персональных данных» при оформлении заказа или регистрации, я свободно, своей волей и в своём интересе даю согласие ${operatorLine(o)} (далее — Оператор) на обработку моих персональных данных на следующих условиях.</p>
<ol>
<li><b>Данные:</b> фамилия, имя, отчество или наименование организации; номер телефона; адрес электронной почты; ИНН; адрес доставки; сведения о заказах${seoCfg().metrika ? '; сведения о посещении сайта, собираемые Яндекс Метрикой (cookie, IP-адрес, данные браузера и устройства)' : ''}.</li>
<li><b>Цели:</b> оформление, подтверждение и исполнение заказа; выставление счетов, накладных и кассовых чеков; связь со мной по заказу; работа личного кабинета и восстановление доступа к нему${seoCfg().metrika ? '; анализ посещаемости и улучшение сайта' : ''}.</li>
<li><b>Действия:</b> сбор, запись, систематизация, накопление, хранение, уточнение, использование, передача (предоставление) лицам, указанным в пункте 4, блокирование, удаление, уничтожение — с использованием средств автоматизации и без них.</li>
<li><b>Передача:</b> платёжному сервису ЮKassa (ООО НКО «ЮМани») для оплаты и кассового чека; службам доставки — если выбрана доставка; почтовому сервису для отправки писем${seoCfg().metrika ? '; ООО «Яндекс» (Яндекс Метрика)' : ''}.</li>
<li><b>Срок:</b> согласие действует до достижения целей обработки или до его отзыва.</li>
<li><b>Отзыв:</b> согласие можно отозвать, направив Оператору заявление ${o.email ? 'на почту ' + h(o.email) : 'любым доступным способом'}${o.phone ? ' (тел. ' + h(o.phone) + ')' : ''}. Оператор прекратит обработку в срок до 10 рабочих дней, кроме случаев, когда обработка необходима для исполнения договора или требований закона.</li>
</ol>
<p>Порядок обработки и защиты данных описан в <a href="/privacy">Политике обработки персональных данных</a>.</p></div>
` + pageEnd();
}
/* ---------- документы: счёт и товарная накладная ---------- */
// ссылки на документы подписаны секретом сервера — их нельзя подобрать перебором номеров
const DOC_SECRET = (() => { let k = getSetting('doc_secret'); if (!k) { k = crypto.randomBytes(32).toString('hex'); setSetting('doc_secret', k); } return k; })();
const docSig = (kind, id) => crypto.createHmac('sha256', DOC_SECRET).update(`${kind}:${id}`).digest('hex').slice(0, 32);
const docLink = (kind, id) => `${SITE_URL}/doc/${kind}/${id}?k=${docSig(kind, id)}`;
const docLinks = inv => ({ invoice: docLink('invoice', inv.id), waybill: inv.shipped ? docLink('waybill', inv.id) : null });
const docsCfg = () => ({ autoInvoice: true, autoWaybill: true, ...(getSetting('docs') || {}) });

function rubWords(sum) {
  const ones = [['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'], ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']];
  const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const plural = (n, f) => { n %= 100; const d = n % 10; return n > 10 && n < 20 ? f[2] : d === 1 ? f[0] : d >= 2 && d <= 4 ? f[1] : f[2]; };
  const triad = (n, fem) => { const w = [hundreds[Math.floor(n / 100)]]; const t = n % 100;
    if (t >= 10 && t < 20) w.push(teens[t - 10]); else { w.push(tens[Math.floor(t / 10)]); w.push(ones[fem ? 1 : 0][t % 10]); } return w.filter(Boolean).join(' '); };
  const rub = Math.floor(sum + 1e-9), kop = Math.round((sum - rub) * 100);
  const groups = [[1e9, ['миллиард', 'миллиарда', 'миллиардов'], 0], [1e6, ['миллион', 'миллиона', 'миллионов'], 0], [1e3, ['тысяча', 'тысячи', 'тысяч'], 1]];
  let n = rub; const out = [];
  for (const [div, f, fem] of groups) { const g = Math.floor(n / div); if (g) { out.push(triad(g, fem), plural(g, f)); n %= div; } }
  if (n || !out.length) out.push(n ? triad(n, 0) : 'ноль');
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  return `${text[0].toUpperCase()}${text.slice(1)} ${plural(rub, ['рубль', 'рубля', 'рублей'])} ${String(kop).padStart(2, '0')} ${plural(kop, ['копейка', 'копейки', 'копеек'])}`;
}
const ruDate = iso => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).replace(' г.', ' г.');
const num2 = n => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderDoc(kind, inv) {
  const o = getOwner(), isInv = kind === 'invoice';
  const title = isInv ? `Счёт на оплату № ${inv.id} от ${ruDate(inv.date)}` : `Товарная накладная № ${inv.id} от ${ruDate(inv.shipped_at || inv.date)}`;
  const seller = [o.name, o.inn && `ИНН ${o.inn}`, o.ogrnip && `ОГРНИП ${o.ogrnip}`, o.addr, o.phone && `тел. ${o.phone}`].filter(Boolean).map(h).join(', ');
  const buyer = [inv.client, inv.inn && `ИНН ${inv.inn}`].filter(Boolean).map(h).join(', ');
  const rows = inv.items.map((x, i) => `<tr><td class="c">${i + 1}</td><td>${h(x.name)}<div class="sku">${h(x.sku)}</div></td><td class="c">${h(x.unit)}</td><td class="r">${x.qty}</td><td class="r">${num2(x.price)}</td><td class="r">${num2(x.qty * x.price)}</td></tr>`).join('');
  const qty = inv.items.reduce((s, x) => s + x.qty, 0);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} — Mebel Segment</title><link rel="icon" href="/favicon.png"><style>
*{box-sizing:border-box}body{margin:0;background:#E8E7E3;font:14px/1.45 Arial,Helvetica,sans-serif;color:#151515}
.bar{max-width:820px;margin:0 auto;padding:14px 16px;display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap}
.bar img{height:30px}.btn{border:0;background:#151515;color:#fff;font-weight:bold;padding:10px 18px;border-radius:999px;cursor:pointer;font-size:13px}
.page{max-width:820px;margin:0 auto 40px;background:#fff;padding:36px 40px;border-radius:12px}
h1{font-size:20px;margin:18px 0 14px}.bank{width:100%;border-collapse:collapse;margin-bottom:6px;font-size:13px}
.bank td{border:1px solid #333;padding:5px 8px;vertical-align:top}table.items{width:100%;border-collapse:collapse;margin-top:14px}
table.items th,table.items td{border:1px solid #333;padding:6px 8px;font-size:13px;vertical-align:top}table.items th{background:#f2f1ed;font-weight:bold}
.c{text-align:center}.r{text-align:right;white-space:nowrap}.sku{color:#777;font-size:11px}.party{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:8px 0}
.party b{font-weight:normal;color:#555}.tot{margin-top:10px;text-align:right}.tot div{margin:2px 0}.words{margin-top:12px;font-weight:bold}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:40px}.sign div{border-top:1px solid #333;padding-top:4px;font-size:12px;color:#555}
.note{font-size:12px;color:#555;margin-top:18px}@media print{body{background:#fff}.bar{display:none}.page{padding:0;margin:0;max-width:none;border-radius:0}}
@media (max-width:600px){.page{padding:20px 14px;border-radius:0}.party{grid-template-columns:1fr}}
</style></head><body><div class="bar"><img src="/logo.png" alt="Mebel Segment"><button class="btn" onclick="window.print()">Печать / сохранить в PDF</button></div><div class="page">
${isInv ? `<table class="bank"><tr><td colspan="2">${h(o.bank || 'Банк получателя')}</td><td>БИК</td><td>${h(o.bik)}</td></tr>
<tr><td colspan="2">Банк получателя</td><td>Сч. №</td><td>${h(o.ks)}</td></tr><tr><td>ИНН ${h(o.inn)}</td><td>КПП —</td><td rowspan="2">Сч. №</td><td rowspan="2">${h(o.acc)}</td></tr>
<tr><td colspan="2">${h(o.name)}<br><span class="sku">Получатель</span></td></tr></table>` : ''}
<h1>${h(title)}</h1>
<div class="party"><b>${isInv ? 'Поставщик' : 'Поставщик (грузоотправитель)'}:</b><span>${seller || '—'}</span><b>${isInv ? 'Покупатель' : 'Покупатель (грузополучатель)'}:</b><span>${buyer || '—'}</span>
${isInv ? '' : `<b>Основание:</b><span>Счёт № ${inv.id} от ${ruDate(inv.date)}</span>`}</div>
<table class="items"><thead><tr><th>№</th><th>Товар</th><th>Ед.</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot"><div>Итого: <b>${num2(inv.sum)} ₽</b></div><div>Без НДС (УСН, п. 2 ст. 346.11 НК РФ)</div><div>Всего к ${isInv ? 'оплате' : 'отпуску'}: <b>${num2(inv.sum)} ₽</b></div></div>
<div>Всего наименований ${inv.items.length}, количество ${qty}, на сумму ${num2(inv.sum)} ₽</div><div class="words">${rubWords(inv.sum)}</div>
${isInv ? `<p class="note">Оплата по счёту означает согласие с условиями поставки. Счёт действителен 5 банковских дней. Товар отпускается по факту поступления денег на расчётный счёт.</p>
<div class="sign"><div>Индивидуальный предприниматель ______________ ${h((o.name || '').replace(/^ИП\s*/, ''))}</div><div></div></div>`
  : `<div class="sign"><div>Отпуск груза произвёл ______________ ${h((o.name || '').replace(/^ИП\s*/, ''))}</div><div>Груз получил ______________ / ______________</div></div>
<div class="sign" style="margin-top:20px"><div>М.П. (при наличии)</div><div>«___» ______________ 20___ г.</div></div>`}
</div></body></html>`;
}
async function sendDoc(kind, invId, to) {
  const [inv] = invoiceRows('WHERE id = ?', invId); if (!inv) throw new UserError('Счёт не найден.', 404);
  if (kind === 'waybill' && !inv.shipped) throw new UserError('Накладная появится после отгрузки.');
  const isInv = kind === 'invoice', o = getOwner();
  const list = inv.items.map(x => `<tr><td style="padding:4px 0">${h(x.name)}</td><td style="padding:4px 0 4px 12px;text-align:right;white-space:nowrap">${x.qty} ${h(x.unit)} × ${rubs(x.price)}</td></tr>`).join('');
  const ok = await mailTo(to, isInv ? `Счёт № ${inv.id} на ${rubs(inv.sum)} — Mebel Segment` : `Заказ отгружен: накладная № ${inv.id} — Mebel Segment`,
    mailWrap(isInv ? `Счёт № ${inv.id} на ${rubs(inv.sum)}` : `Ваш заказ отгружен`,
      `<p>Здравствуйте, ${h(inv.client)}!</p><p>${isInv ? 'Спасибо за заказ. Счёт на оплату — по кнопке ниже: его можно распечатать или сохранить в PDF.' : 'Заказ по счёту № ' + inv.id + ' отгружен. Товарная накладная — по кнопке ниже.'}</p>
       <table style="width:100%;border-collapse:collapse;font-size:14px;border-top:1px solid #e3e1dc;border-bottom:1px solid #e3e1dc;margin:12px 0">${list}</table>
       <p style="font-size:16px"><b>Итого: ${rubs(inv.sum)}</b> <span style="color:#8a8984">без НДС</span></p>
       ${o.phone ? `<p style="color:#555">Вопросы — по телефону ${h(o.phone)}.</p>` : ''}`,
      { text: isInv ? 'Открыть счёт' : 'Открыть накладную', url: docLink(kind, inv.id) }));
  if (!ok) throw new UserError('Почта не подключена. Подключите её в «Настройки → Почта».');
  if (isInv) db.prepare('UPDATE invoices SET email = ? WHERE id = ?').run(to, inv.id);
  return true;
}
function autoDoc(kind, invId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
  if (!inv || !inv.email || !mailCfg() || !docsCfg()[kind === 'invoice' ? 'autoInvoice' : 'autoWaybill']) return;
  sendDoc(kind, invId, inv.email).catch(e => console.error('Документ на почту:', e.message));
}


/* ---------- ежедневная копия базы на почту владельцу ---------- */
const zlib = require('node:zlib');
const backupCfg = () => ({ daily: true, ...(getSetting('backup') || {}) });
// архив tar.gz папки uploads (формат ustar, без внешних программ); null — если фото нет
function photosTarGz() {
  const names = fs.readdirSync(UPLOADS).filter(n => /^[0-9]+-[0-9a-f]{12}\.(jpg|png|webp)$/.test(n));
  if (!names.length) return null;
  const parts = [];
  for (const n of names) {
    const data = fs.readFileSync(path.join(UPLOADS, n)), hd = Buffer.alloc(512);
    const put = (v, off, len) => hd.write(v, off, len, 'ascii');
    put('uploads/' + n, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
    put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
    put('        ', 148, 8); put('0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    put(hd.reduce((s, x) => s + x, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
    parts.push(hd, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}
async function sendBackup() {
  const m = mailCfg(); if (!m || !m.to) throw new UserError('Сначала подключите почту: «Настройки» → «Почта».');
  const tmp = path.join(DATA_DIR, `backup-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // согласованная копия без остановки сайта
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    const day = new Date().toLocaleDateString('ru-RU'), stamp = new Date().toISOString().slice(0, 10);
    const cnt = t => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const files = [{ name: `mebel-segment-${stamp}.db.gz`, type: 'application/gzip', content: gz }];
    // фото товаров — отдельным архивом, если письмо не выходит слишком большим (у почтовых сервисов лимит ~25 МБ)
    const photos = photosTarGz();
    const withPhotos = photos && gz.length + photos.length < 18 * 1024 * 1024;
    if (withPhotos) files.push({ name: `mebel-segment-photos-${stamp}.tar.gz`, type: 'application/gzip', content: photos });
    await smtpSend(m, m.to, `Копия базы Mebel Segment за ${day}`, mailWrap(`Копия базы за ${day}`,
      `<p>Во вложении — полная копия данных сайта: товары, остатки, заказы, счета, клиенты, банки и настройки${withPhotos ? ', а также фотографии товаров' : ''}.</p>
       <p style="color:#555">Сейчас в базе: товаров ${db.prepare('SELECT COUNT(*) c FROM products WHERE active = 1').get().c}, заказов ${cnt('orders')}, счетов ${cnt('invoices')}, клиентов ${cnt('customers')}.</p>
       <p style="color:#8a8984;font-size:13px">Храните эти письма — из любого из них можно восстановить сайт.${photos && !withPhotos ? ' Фото товаров слишком много для письма — они хранятся в копиях на сервере.' : ''} В файле есть личные данные клиентов: не пересылайте его посторонним.</p>`),
      files);
    setSetting('backup_last', { at: now(), size: gz.length });
    return { size: gz.length };
  } finally { fs.rm(tmp, () => {}); }
}
setInterval(() => {
  try {
    const h = new Date().getHours(), today = new Date().toDateString(), last = getSetting('backup_last');
    if (h < 3 || !backupCfg().daily || !mailCfg() || (last && new Date(last.at).toDateString() === today)) return;
    sendBackup().catch(e => console.error('Копия базы:', e.message));
  } catch (e) { console.error('Копия базы:', e.message); }
}, 10 * 60 * 1000).unref();


/* ---------- загрузка банковской выписки (формат 1С: 1CClientBankExchange) ---------- */
function parse1C(buf) {
  let text = buf.toString('utf8');
  if (!text.startsWith('﻿1CClientBankExchange') && !text.startsWith('1CClientBankExchange') || /Кодировка=Windows/i.test(new TextDecoder('windows-1251').decode(buf.subarray(0, 300))))
    text = new TextDecoder('windows-1251').decode(buf);
  text = text.replace(/^﻿/, '');
  if (!text.startsWith('1CClientBankExchange')) throw new UserError('Это не выписка в формате 1С. В интернет-банке выберите «Экспорт в 1С» (файл обычно kl_to_1c.txt).');
  const accounts = [], docs = [], headAccs = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const i = line.indexOf('='), k = i > 0 ? line.slice(0, i) : line, v = i > 0 ? line.slice(i + 1).trim() : '';
    if (k === 'СекцияРасчСчет') { cur = {}; accounts.push(cur); continue; }
    if (k === 'СекцияДокумент') { cur = { _type: v }; docs.push(cur); continue; }
    if (k === 'КонецРасчСчет' || k === 'КонецДокумента') { cur = null; continue; }
    if (cur && i > 0) cur[k] = cur[k] ? cur[k] + ' ' + v : v;
    else if (!cur && k === 'РасчСчет') headAccs.push(v);
  }
  if (!accounts.length) for (const v of headAccs) accounts.push({ РасчСчет: v });
  return { accounts, docs };
}
const num1C = v => { const t = String(v ?? '').replace(/\s/g, '').replace(',', '.'); if (!t) return NaN; const n = Number(t); return Number.isFinite(n) ? r2(n) : NaN; };
const date1C = v => { const m = String(v || '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}T12:00:00.000Z` : null; };
function importStatement(buf, bankId) {
  const { accounts, docs } = parse1C(buf);
  const ourAccs = new Set(accounts.map(a => (a.РасчСчет || '').replace(/\D/g, '')).filter(Boolean));
  const banks = db.prepare('SELECT * FROM banks').all();
  let bank = banks.find(b => b.id === posInt(bankId));
  if (!bank) bank = banks.find(b => b.acc && [...ourAccs].some(a => a.endsWith(b.acc.replace(/\D/g, ''))));
  if (!bank) throw new UserError('Выберите, в какой банк загрузить выписку.');
  const acc = [...ourAccs].find(a => bank.acc && a.endsWith(bank.acc.replace(/\D/g, ''))) || [...ourAccs][0] || '';
  const res = { bank: bank.name, added: 0, skipped: 0, paid: [], balance: null, from: null, to: null };
  const ins = db.prepare('INSERT OR IGNORE INTO txns (date, bank_id, text, amount, ext_id) VALUES (?, ?, ?, ?, ?)');
  const issued = db.prepare("SELECT * FROM invoices WHERE status = 'issued'").all();
  const sumOf = id => r2(db.prepare('SELECT COALESCE(SUM(qty * price), 0) s FROM invoice_items WHERE invoice_id = ?').get(id).s);
  return tx(() => {
    let delta = 0;
    for (const d of docs) {
      const sum = num1C(d.Сумма); if (!(sum > 0)) continue;
      const payerAcc = (d.ПлательщикСчет || d.ПлательщикРасчСчет || '').replace(/\D/g, ''), rcvAcc = (d.ПолучательСчет || d.ПолучательРасчСчет || '').replace(/\D/g, '');
      const incoming = acc ? rcvAcc === acc : !!d.ДатаПоступило;
      const outgoing = acc ? payerAcc === acc : !!d.ДатаСписано;
      if (!incoming && !outgoing) continue;
      const date = date1C(incoming ? d.ДатаПоступило || d.Дата : d.ДатаСписано || d.Дата) || now();
      const who = (incoming ? d.Плательщик1 || d.Плательщик : d.Получатель1 || d.Получатель || '').replace(/^ИНН\s*\d+\s*/, '').trim();
      const purpose = (d.НазначениеПлатежа || '').trim();
      const ext = crypto.createHash('sha1').update([d.Номер, d.Дата, sum, payerAcc, rcvAcc, incoming ? 'in' : 'out'].join('|')).digest('hex');
      let text = `${incoming ? 'От' : 'Кому'}: ${who || '—'}${purpose ? '. ' + purpose : ''}`.slice(0, 300);
      // оплата по нашему счёту: номер счёта в назначении или ИНН плательщика + точная сумма
      if (incoming) {
        const nums = [...purpose.matchAll(/(?:сч(?:[её]т(?:у|а)?)?|сч\.)\s*(?:на\s*оплату\s*)?№?\s*(\d{1,7})/gi)].map(m => Number(m[1]));
        const payerInn = (d.ПлательщикИНН || '').replace(/\D/g, '');
        let inv = issued.find(i => nums.includes(i.id) && sumOf(i.id) === sum)
          || (payerInn && issued.filter(i => i.inn === payerInn && sumOf(i.id) === sum).length === 1 && issued.find(i => i.inn === payerInn && sumOf(i.id) === sum));
        if (inv) {
          const r = ins.run(date, bank.id, `Оплата по счёту №${inv.id}, ${who || inv.client}`.slice(0, 300), sum, ext);
          if (r.changes) {
            db.prepare("UPDATE invoices SET status = 'paid', paid_bank = ? WHERE id = ? AND status = 'issued'").run(bank.id, inv.id);
            issued.splice(issued.indexOf(inv), 1); res.paid.push({ id: inv.id, client: inv.client, sum }); res.added++; delta += sum;
          } else res.skipped++;
          continue;
        }
      }
      const r = ins.run(date, bank.id, text, incoming ? sum : -sum, ext);
      if (r.changes) { res.added++; delta += incoming ? sum : -sum; } else res.skipped++;
    }
    const mine = accounts.filter(x => (x.РасчСчет || '').replace(/\D/g, '') === acc);
    const a = mine.find(x => x.КонечныйОстаток) || mine[0] || accounts[0];
    const end = a ? num1C(a.КонечныйОстаток) : NaN;
    res.from = a && a.ДатаНачала || null; res.to = a && a.ДатаКонца || null;
    if (Number.isFinite(end)) { db.prepare('UPDATE banks SET balance = ? WHERE id = ?').run(end, bank.id); res.balance = end; }
    else if (delta) { db.prepare('UPDATE banks SET balance = round(balance + ?, 2) WHERE id = ?').run(r2(delta), bank.id); res.balance = r2(bank.balance + delta); }
    if (acc && !bank.acc) db.prepare('UPDATE banks SET acc = ? WHERE id = ?').run(acc.slice(-4), bank.id);
    return res;
  });
}

/* ---------- маршруты ---------- */
const routes = {
  'GET /api/catalog': () => ({
    cats: CATS,
    owner: (({ phone, email, name, inn, ogrnip }) => ({ phone, email, name, inn, ogrnip }))(getOwner()),
    online: !!ykCfg(),
    products: db.prepare('SELECT id, sku, name, cat, unit, price, stock, photo, box, descr FROM products WHERE active = 1 ORDER BY id').all(),
  }),
  'POST /api/orders': async (b, req) => { const r = tx(() => {
    const me = customerOf(req);
    const client = str(b.name, 120), phone = str(b.phone, 40), inn = str(b.inn, 12).replace(/\D/g, '');
    if (!client || phone.replace(/\D/g, '').length < 10) throw new UserError('Укажите имя и телефон из 10–11 цифр.');
    if (b.consent !== true) throw new UserError('Отметьте согласие на обработку персональных данных — без него мы не можем принять заказ.');
    const tags = [b.kind === 'company' ? 'Организация / ИП' : 'Частное лицо', b.delivery === 'delivery' ? 'Доставка' : 'Самовывоз'];
    const comment = [tags.join(' · '), str(b.comment, 500)].filter(Boolean).join('. ');
    // товар без остатка можно заказать «под заказ»: владелец подтвердит срок, списание — только при отгрузке
    const email = normEmail(b.email) || (me ? me.email : '');
    if (email && !validEmail(email)) throw new UserError('Проверьте адрес почты.');
    const items = readItems(b.items, false);
    const o = db.prepare('INSERT INTO orders (date, client, phone, inn, comment, customer_id, consent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), client, phone, inn || null, comment || null, me ? me.id : null, `${now()} ред. ${PRIVACY_DATE}`);
    const invId = createInvoice({ client, inn, items, orderId: Number(o.lastInsertRowid) });
    if (email) db.prepare('UPDATE invoices SET email = ? WHERE id = ?').run(email, invId);
    return { order: Number(o.lastInsertRowid), invoice: invId, sum: r2(items.reduce((s, x) => s + x.qty * x.p.price, 0)) };
  }); notifyOrder(r.order); autoDoc('invoice', r.invoice);
    if (b.pay === 'online' && ykCfg()) {
      try { r.pay_url = await startPayment(r.invoice); }
      catch (e) { console.error('ЮKassa:', e.message); r.pay_error = 'Не получилось перейти к онлайн-оплате. Заказ принят — мы пришлём счёт.'; }
    }
    return r; },
  'POST /api/pay/start': async (b, req) => {
    const me = customerOf(req); if (!me) throw new UserError('Войдите в личный кабинет.', 401);
    const inv = db.prepare('SELECT i.id FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = ? AND o.customer_id = ?').get(posInt(b.invoice), me.id);
    if (!inv) throw new UserError('Счёт не найден.', 404);
    try { return { pay_url: await startPayment(inv.id) }; } catch (e) { if (e instanceof UserError) throw e; throw new UserError('Не получилось начать оплату: ' + e.message + '.'); }
  },
  'GET /api/pay/status': async (b, req, res, url) => {
    const row = db.prepare('SELECT * FROM payments WHERE token = ?').get(str(url.searchParams.get('t'), 64));
    if (!row) throw new UserError('Платёж не найден.', 404);
    let status = row.status;
    try { status = (await syncPayment(row.id)) || status; } catch (e) { console.error('ЮKassa:', e.message); }
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(row.invoice_id);
    return { status, paid: inv.status === 'paid', order: inv.order_id, invoice: inv.id, sum: row.amount };
  },
  'POST /api/pay/retry': async (b) => {
    const row = db.prepare('SELECT * FROM payments WHERE token = ?').get(str(b.t, 64));
    if (!row) throw new UserError('Платёж не найден.', 404);
    try { return { pay_url: await startPayment(row.invoice_id) }; } catch (e) { if (e instanceof UserError) throw e; throw new UserError('Не получилось начать оплату: ' + e.message + '.'); }
  },
  'POST /api/yookassa/webhook': async (b) => {
    const id = b && b.object && b.object.id;
    if (id) { try { await syncPayment(String(id)); } catch (e) { console.error('ЮKassa webhook:', e.message); } }
    return { ok: true };
  },
  'POST /api/login': (b, req, res) => {
    const lim = tooMany(req, 'admin:');
    if (!ADMIN_PASSWORD || !safeEqual(str(b.password, 200), ADMIN_PASSWORD)) { lim.fail(); throw new UserError('Неверный пароль.', 401); }
    lim.ok(); newSession(res, req, 'admin');
    return { ok: true };
  },
  'POST /api/logout': (b, req, res) => { endSession(req, res, 'admin'); return { ok: true }; },

  /* ---- личный кабинет клиента ---- */
  'POST /api/account/register': (b, req, res) => {
    const email = normEmail(b.email), pw = String(b.password || ''), name = str(b.name, 120), phone = str(b.phone, 40);
    if (!validEmail(email)) throw new UserError('Проверьте адрес почты.');
    if (pw.length < 8 || pw.length > 200) throw new UserError('Пароль — не меньше 8 символов.');
    if (!name) throw new UserError('Укажите имя или название компании.');
    if (digits(phone).length < 10) throw new UserError('Укажите телефон из 10–11 цифр.');
    if (b.consent !== true) throw new UserError('Отметьте согласие на обработку персональных данных.');
    if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email)) throw new UserError('Эта почта уже зарегистрирована. Войдите или попросите сбросить пароль.', 409);
    const id = Number(db.prepare('INSERT INTO customers (email, pass, name, phone, company, inn, created, consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(email, hashPass(pw), name, phone, str(b.company, 160), str(b.inn, 12).replace(/\D/g, ''), now(), `${now()} ред. ${PRIVACY_DATE}`).lastInsertRowid);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    linkOrders(c); newSession(res, req, 'customer', id);
    notify(`👋 <b>Новый клиент на сайте</b>\n${h(c.name)}${c.company ? ' · ' + h(c.company) : ''}\n📞 ${h(c.phone)}\n✉️ ${h(c.email)}`, { text: 'Клиенты в кабинете', url: SITE_URL + '/admin' }, `Новый клиент на сайте: ${c.name}`);
    return { ok: true };
  },
  'POST /api/account/login': (b, req, res) => {
    const lim = tooMany(req, 'cust:');
    const c = db.prepare('SELECT * FROM customers WHERE email = ?').get(normEmail(b.email));
    if (!c || !checkPass(String(b.password || ''), c.pass)) { lim.fail(); throw new UserError('Неверная почта или пароль.', 401); }
    lim.ok(); linkOrders(c); newSession(res, req, 'customer', c.id);
    return { ok: true };
  },
  'POST /api/account/logout': (b, req, res) => { endSession(req, res, 'customer'); return { ok: true }; },
  'GET /api/account/me': (b, req) => {
    const c = customerOf(req); if (!c) throw new UserError('Войдите в личный кабинет.', 401);
    const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(c.id);
    const invs = orders.length ? invoiceRows(`WHERE order_id IN (${orders.map(() => '?').join(',')})`, ...orders.map(o => o.id)) : [];
    const list = orders.map(o => { const i = invs.find(x => x.order_id === o.id); return { ...o, invoice: i ? { ...i, links: docLinks(i) } : null }; });
    const live = list.filter(o => o.invoice && o.invoice.status !== 'cancelled' && o.invoice.status !== 'refunded');
    const year = String(new Date().getFullYear());
    const o = getOwner();
    return {
      me: publicCustomer(c), orders: list, online: !!ykCfg(),
      totals: { orders: live.length, total: r2(live.reduce((s, x) => s + x.invoice.sum, 0)),
        year: r2(live.filter(x => x.date.startsWith(year)).reduce((s, x) => s + x.invoice.sum, 0)),
        unpaid: r2(live.filter(x => x.invoice.status === 'issued').reduce((s, x) => s + x.invoice.sum, 0)) },
      owner: { name: o.name, inn: o.inn, ogrnip: o.ogrnip, addr: o.addr, bank: o.bank, acc: o.acc, bik: o.bik, ks: o.ks, phone: o.phone },
    };
  },
  'POST /api/account/profile': (b, req) => {
    const c = customerOf(req); if (!c) throw new UserError('Войдите в личный кабинет.', 401);
    const name = str(b.name, 120), phone = str(b.phone, 40);
    if (!name) throw new UserError('Укажите имя или название компании.');
    if (digits(phone).length < 10) throw new UserError('Укажите телефон из 10–11 цифр.');
    db.prepare('UPDATE customers SET name = ?, phone = ?, company = ?, inn = ? WHERE id = ?').run(name, phone, str(b.company, 160), str(b.inn, 12).replace(/\D/g, ''), c.id);
    linkOrders({ ...c, phone });
    return { ok: true };
  },
  'POST /api/account/forgot': async (b, req) => {
    const lim = tooMany(req, 'forgot:');
    if (!mailCfg()) throw new UserError('Восстановление по почте пока не подключено. Позвоните нам — сбросим пароль.');
    const c = db.prepare('SELECT * FROM customers WHERE email = ?').get(normEmail(b.email));
    lim.fail(); // считаем каждую попытку, чтобы нельзя было перебирать почты
    if (c) {
      const t = crypto.randomBytes(24).toString('hex');
      db.prepare('DELETE FROM resets WHERE exp < ? OR customer_id = ?').run(Date.now(), c.id);
      db.prepare('INSERT INTO resets (token, customer_id, exp) VALUES (?, ?, ?)').run(tokenHash(t), c.id, Date.now() + 60 * 60 * 1000);
      try {
        await mailTo(c.email, 'Восстановление пароля — Mebel Segment', mailWrap('Новый пароль для личного кабинета',
          `<p>Здравствуйте, ${h(c.name)}!</p><p>Чтобы задать новый пароль, нажмите кнопку ниже. Ссылка действует 1 час.</p><p style="color:#8a8984;font-size:13px">Если вы не просили сменить пароль, просто удалите это письмо.</p>`,
          { text: 'Задать новый пароль', url: `${SITE_URL}/?reset=${t}#account` }));
      } catch (e) { console.error('Почта:', e.message); throw new UserError('Не получилось отправить письмо. Попробуйте позже или позвоните нам.'); }
    }
    return { ok: true }; // одинаковый ответ, чтобы не раскрывать, зарегистрирована ли почта
  },
  'POST /api/account/reset': (b, req, res) => {
    const r = db.prepare('SELECT * FROM resets WHERE token = ?').get(tokenHash(str(b.token, 100)));
    if (!r || r.exp < Date.now()) throw new UserError('Ссылка устарела или уже использована. Запросите новую.');
    const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 200) throw new UserError('Пароль — не меньше 8 символов.');
    db.prepare('UPDATE customers SET pass = ? WHERE id = ?').run(hashPass(pw), r.customer_id);
    db.prepare('DELETE FROM resets WHERE customer_id = ?').run(r.customer_id);
    db.prepare("DELETE FROM sessions WHERE kind = 'customer' AND customer_id = ?").run(r.customer_id);
    newSession(res, req, 'customer', r.customer_id);
    return { ok: true };
  },
  'POST /api/account/password': (b, req) => {
    const c = customerOf(req); if (!c) throw new UserError('Войдите в личный кабинет.', 401);
    if (!checkPass(String(b.old || ''), c.pass)) throw new UserError('Текущий пароль указан неверно.');
    const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 200) throw new UserError('Новый пароль — не меньше 8 символов.');
    db.prepare('UPDATE customers SET pass = ? WHERE id = ?').run(hashPass(pw), c.id);
    return { ok: true };
  },
  'POST /api/admin/customers/reset': (b) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(posInt(b.id));
    if (!c) throw new UserError('Клиент не найден.', 404);
    const temp = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) + Math.floor(10 + Math.random() * 89);
    db.prepare('UPDATE customers SET pass = ? WHERE id = ?').run(hashPass(temp), c.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'customer' AND customer_id = ?").run(c.id);
    return { password: temp };
  },
  'GET /api/admin/state': () => adminState(),
  'POST /api/admin/invoices': (b) => tx(() => {
    const client = str(b.client, 160); if (!client) throw new UserError('Укажите покупателя.');
    const email = normEmail(b.email); if (email && !validEmail(email)) throw new UserError('Проверьте почту покупателя.');
    const id = createInvoice({ client, inn: str(b.inn, 12).replace(/\D/g, ''), items: readItems(b.items, false) });
    if (email) { db.prepare('UPDATE invoices SET email = ? WHERE id = ?').run(email, id); autoDoc('invoice', id); }
    return { id };
  }),
  'POST /api/admin/invoices/pay': (b) => tx(() => {
    const [inv] = invoiceRows('WHERE id = ?', posInt(b.id));
    if (!inv) throw new UserError('Счёт не найден.', 404);
    if (inv.status !== 'issued') throw new UserError(inv.status === 'paid' ? 'Счёт уже оплачен.' : 'Этот счёт отменён или по нему был возврат.');
    const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(posInt(b.bank));
    if (!bank) throw new UserError('Выберите банк.');
    db.prepare("UPDATE invoices SET status = 'paid', paid_bank = ? WHERE id = ?").run(bank.id, inv.id);
    db.prepare('UPDATE banks SET balance = round(balance + ?, 2) WHERE id = ?').run(inv.sum, bank.id);
    db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id, `Оплата по счёту №${inv.id}, ${inv.client}`, inv.sum);
    return { ok: true };
  }),
  'POST /api/admin/invoices/ship': (b) => tx(() => {
    const [inv] = invoiceRows('WHERE id = ?', posInt(b.id));
    if (!inv) throw new UserError('Счёт не найден.', 404);
    if (inv.shipped) throw new UserError('Счёт уже отгружен.');
    if (inv.status === 'cancelled' || inv.status === 'refunded') throw new UserError('Отменённый счёт отгрузить нельзя.');
    const getP = db.prepare('SELECT * FROM products WHERE id = ?');
    for (const x of inv.items) { const p = getP.get(x.product_id); if (p.stock < x.qty) throw new UserError(`Не хватает: ${p.name} (на складе ${p.stock}).`); }
    const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const x of inv.items) upd.run(x.qty, x.product_id);
    db.prepare('UPDATE invoices SET shipped = 1, shipped_at = ? WHERE id = ?').run(now(), inv.id);
    if (inv.order_id) db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(inv.order_id);
    return { ok: true, id: inv.id };
  }) && (autoDoc('waybill', posInt(b.id)), { ok: true }),
  'POST /api/admin/invoices/cancel': (b) => tx(() => {
    const [inv] = invoiceRows('WHERE id = ?', posInt(b.id));
    if (!inv) throw new UserError('Счёт не найден.', 404);
    if (inv.status !== 'issued' || inv.shipped) throw new UserError(inv.status === 'paid' ? 'Оплаченный счёт не отменяют — оформите возврат денег.' : 'Этот счёт отменить нельзя.');
    db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(inv.id);
    if (inv.order_id) db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(inv.order_id);
    return { ok: true };
  }),
  // возврат денег: оплаченные онлайн — через ЮKassa (с чеком возврата), оплаченные по счёту — запись о переводе вручную
  'POST /api/admin/invoices/refund': async (b) => {
    const [inv] = invoiceRows('WHERE id = ?', posInt(b.id));
    if (!inv) throw new UserError('Счёт не найден.', 404);
    if (inv.status !== 'paid') throw new UserError('Вернуть деньги можно только по оплаченному счёту.');
    const reason = str(b.reason, 200), restock = !!b.restock && !!inv.shipped;
    const pay = db.prepare("SELECT * FROM payments WHERE invoice_id = ? AND status = 'succeeded' ORDER BY created DESC").get(inv.id);
    let refundId = 'manual-' + crypto.randomBytes(8).toString('hex'), status = 'succeeded';
    if (pay) {
      const cfg = ykCfg(); if (!cfg) throw new UserError('Счёт оплачен онлайн, а ЮKassa отключена. Подключите её снова, чтобы вернуть деньги на карту.');
      const body = { payment_id: pay.id, amount: { value: r2(pay.amount).toFixed(2), currency: 'RUB' }, description: (reason || `Возврат по счёту №${inv.id}`).slice(0, 250) };
      if (cfg.receipt) {
        const o = inv.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(inv.order_id) : null;
        const c = o && o.customer_id ? db.prepare('SELECT email FROM customers WHERE id = ?').get(o.customer_id) : null;
        body.receipt = receiptFor(cfg, inv, o, c);
      }
      let r; try { r = await ykApi(cfg, 'POST', '/refunds', body); } catch (e) { throw new UserError('ЮKassa не приняла возврат: ' + e.message + '.'); }
      if (r.status === 'canceled') throw new UserError('ЮKassa отклонила возврат' + (r.cancellation_details ? ` (${r.cancellation_details.reason})` : '') + '.');
      refundId = r.id; status = r.status;
    }
    const amount = pay ? r2(pay.amount) : inv.sum;
    tx(() => {
      const cur = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
      if (cur.status !== 'paid') throw new UserError('По этому счёту возврат уже оформлен.');
      const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(cur.paid_bank) || db.prepare('SELECT * FROM banks ORDER BY id LIMIT 1').get();
      db.prepare('INSERT INTO refunds (id, invoice_id, payment_id, amount, status, created, reason, bank_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(refundId, inv.id, pay ? pay.id : null, amount, status, now(), reason || null, bank ? bank.id : null);
      db.prepare("UPDATE invoices SET status = 'refunded' WHERE id = ?").run(inv.id);
      if (inv.order_id) db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(inv.order_id);
      if (bank) {
        db.prepare('UPDATE banks SET balance = round(balance - ?, 2) WHERE id = ?').run(amount, bank.id);
        db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id,
          `Возврат${pay ? ' через ЮKassa' : ''} по счёту №${inv.id}, ${inv.client}${reason ? '. ' + reason : ''}`.slice(0, 300), -amount);
      }
      if (restock) { const up = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?'); for (const x of inv.items) up.run(x.qty, x.product_id); }
    });
    return { online: !!pay, status, amount };
  },
  'POST /api/admin/products': (b) => {
    const sku = str(b.sku, 40), name = str(b.name, 160), cat = CATS.includes(b.cat) ? b.cat : 'Прочее', unit = str(b.unit, 12) || 'шт', price = money(b.price);
    const box = posInt(b.box) || null, descr = str(b.descr, 300) || null;
    if (!sku || !name || !(price > 0)) throw new UserError('Заполните артикул, название и цену.');
    if (b.id) {
      const r = db.prepare('UPDATE products SET sku = ?, name = ?, cat = ?, unit = ?, price = ?, box = ?, descr = ? WHERE id = ? AND active = 1').run(sku, name, cat, unit, price, box, descr, posInt(b.id));
      if (!r.changes) throw new UserError('Товар не найден.', 404);
      return { id: posInt(b.id) };
    }
    return { id: Number(db.prepare('INSERT INTO products (sku, name, cat, unit, price, box, descr) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sku, name, cat, unit, price, box, descr).lastInsertRowid) };
  },
  'POST /api/admin/products/photo': (b) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(posInt(b.id));
    if (!p) throw new UserError('Товар не найден.', 404);
    let name = null;
    if (b.data) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data));
      if (!m) throw new UserError('Нужна картинка JPG, PNG или WebP.');
      const buf = Buffer.from(m[2], 'base64');
      const sig = buf.subarray(0, 12).toString('hex');
      const ok = (m[1] === 'jpeg' && sig.startsWith('ffd8ff')) || (m[1] === 'png' && sig.startsWith('89504e47')) || (m[1] === 'webp' && sig.startsWith('52494646') && sig.endsWith('57454250'));
      if (!ok) throw new UserError('Файл не похож на картинку.');
      name = `${p.id}-${crypto.randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(UPLOADS, name), buf);
    }
    db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(name, p.id);
    if (p.photo) fs.rm(path.join(UPLOADS, path.basename(p.photo)), () => {});
    return { photo: name };
  },
  'POST /api/admin/products/remove': (b) => {
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(posInt(b.id));
    return { ok: true };
  },
  'POST /api/admin/receipts': (b) => tx(() => {
    const supplier = str(b.supplier, 160); if (!supplier) throw new UserError('Укажите поставщика.');
    const items = readItems(b.items, true);
    const bank = b.bank ? db.prepare('SELECT * FROM banks WHERE id = ?').get(posInt(b.bank)) : null;
    const rc = db.prepare('INSERT INTO receipts (date, supplier, bank_id) VALUES (?, ?, ?)').run(now(), supplier, bank ? bank.id : null);
    const id = Number(rc.lastInsertRowid);
    const ins = db.prepare('INSERT INTO receipt_items (receipt_id, product_id, qty, cost) VALUES (?, ?, ?, ?)');
    const upd = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
    let sum = 0;
    for (const x of items) { ins.run(id, x.p.id, x.qty, x.cost); upd.run(x.qty, x.p.id); sum += x.qty * x.cost; }
    sum = r2(sum);
    if (bank && sum > 0) {
      db.prepare('UPDATE banks SET balance = round(balance - ?, 2) WHERE id = ?').run(sum, bank.id);
      db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id, `Поставщику ${supplier}, приход №${id}`, -sum);
    }
    return { id };
  }),
  'POST /api/admin/banks': (b) => tx(() => {
    const name = str(b.name, 80), acc = str(b.acc, 40);
    if (!name) throw new UserError('Укажите название банка.');
    if (b.id) {
      const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(posInt(b.id));
      if (!bank) throw new UserError('Банк не найден.', 404);
      db.prepare('UPDATE banks SET name = ?, acc = ? WHERE id = ?').run(name, acc, bank.id);
      if (b.balance !== undefined && b.balance !== '') {
        const bal = Number(b.balance); if (!Number.isFinite(bal)) throw new UserError('Остаток должен быть числом.');
        const diff = r2(bal - bank.balance);
        if (diff) {
          db.prepare('UPDATE banks SET balance = ? WHERE id = ?').run(r2(bal), bank.id);
          db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id, 'Корректировка остатка вручную', diff);
        }
      }
      return { id: bank.id };
    }
    return { id: Number(db.prepare('INSERT INTO banks (name, acc) VALUES (?, ?)').run(name, acc).lastInsertRowid) };
  }),
  'POST /api/admin/statement': (b) => {
    const m = /^data:[^;]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
    if (!m) throw new UserError('Выберите файл выписки.');
    const res = importStatement(Buffer.from(m[1], 'base64'), b.bank);
    if (res.paid.length) notify(`🏦 <b>Оплачено по выписке ${h(res.bank)}</b>\n` + res.paid.map(p => `Счёт №${p.id} — ${h(p.client)} — ${rubs(p.sum)}`).join('\n'),
      { text: 'Открыть в кабинете', url: SITE_URL + '/admin' }, `Оплачено по выписке: ${res.paid.length} счёт(а)`);
    return res;
  },
  'POST /api/admin/txns': (b) => tx(() => {
    const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(posInt(b.bank));
    const amount = Number(b.amount), text = str(b.text, 200);
    if (!bank) throw new UserError('Выберите банк.');
    if (!Number.isFinite(amount) || !amount) throw new UserError('Укажите сумму (с минусом для расхода).');
    if (!text) throw new UserError('Укажите назначение операции.');
    db.prepare('UPDATE banks SET balance = round(balance + ?, 2) WHERE id = ?').run(r2(amount), bank.id);
    db.prepare('INSERT INTO txns (date, bank_id, text, amount) VALUES (?, ?, ?, ?)').run(now(), bank.id, text, r2(amount));
    return { ok: true };
  }),
  'POST /api/admin/telegram': async (b) => {
    const token = str(b.token, 100);
    if (!/^\d{5,}:[\w-]{20,}$/.test(token)) throw new UserError('Это не похоже на токен бота. Скопируйте его из сообщения @BotFather целиком.');
    let me; try { me = await tgCall(token, 'getMe'); } catch (e) { throw new UserError(/связаться/.test(e.message) ? 'Не получилось: ' + e.message + '.' : 'Telegram не принял токен: ' + e.message); }
    setSetting('tg', { token, bot: me.username });
    return { bot: me.username };
  },
  'POST /api/admin/telegram/link': async () => {
    const t = getSetting('tg'); if (!t || !t.token) throw new UserError('Сначала сохраните токен бота.');
    let ups; try { ups = await tgCall(t.token, 'getUpdates', { limit: 50, allowed_updates: ['message'] }); } catch (e) { throw new UserError('Не удалось связаться с Telegram: ' + e.message); }
    const msg = ups.map(u => u.message).filter(m => m && m.chat).pop();
    if (!msg) throw new UserError(`Откройте бота @${t.bot} в Telegram, нажмите «Start» (или напишите ему любое сообщение) и нажмите «Привязать» ещё раз.`);
    const chat = msg.chat, name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'чат';
    setSetting('tg', { ...t, chat_id: chat.id, chat_name: name });
    await tgSend('✅ <b>Готово!</b> Сюда будут приходить новые заказы и регистрации с сайта mebel-segment.ru.');
    return { chat: name };
  },
  'POST /api/admin/telegram/test': async () => {
    try { if (!(await tgSend('🔔 Проверка: уведомления Mebel Segment работают.'))) throw new Error('бот не привязан'); }
    catch (e) { throw new UserError('Не отправилось: ' + e.message); }
    return { ok: true };
  },
  'POST /api/admin/mail': async (b) => {
    const old = getSetting('mail') || {};
    const m = { host: str(b.host, 100).toLowerCase(), port: posInt(b.port) || 465, user: normEmail(b.user), pass: String(b.pass || '').replace(/\s+/g, '') || old.pass || '', to: normEmail(b.to) || normEmail(b.user) };
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(m.host)) throw new UserError('Укажите почтовый сервер, например smtp.yandex.ru.');
    if (!validEmail(m.user)) throw new UserError('Укажите адрес ящика, с которого отправлять письма.');
    if (!m.pass) throw new UserError('Укажите пароль приложения для этого ящика.');
    if (!validEmail(m.to)) throw new UserError('Проверьте адрес для уведомлений.');
    try { await smtpSend(m, m.to, 'Проверка почты — Mebel Segment', mailWrap('Почта подключена ✅', '<p>Сюда будут приходить новые заказы и регистрации клиентов с сайта. Клиенты смогут восстанавливать пароль по почте.</p>')); }
    catch (e) { throw new UserError('Не получилось отправить проверочное письмо: ' + e.message + '.'); }
    setSetting('mail', m);
    return { ok: true };
  },
  'POST /api/admin/invoices/send': async (b) => {
    const to = normEmail(b.email); if (!validEmail(to)) throw new UserError('Укажите почту клиента.');
    await sendDoc(b.kind === 'waybill' ? 'waybill' : 'invoice', posInt(b.id), to);
    return { ok: true };
  },
  'POST /api/admin/backup': (b) => { setSetting('backup', { daily: !!b.daily }); return { ok: true }; },
  'POST /api/admin/backup/now': async () => {
    try { return await sendBackup(); } catch (e) { if (e instanceof UserError) throw e; throw new UserError('Не получилось отправить копию: ' + e.message + '.'); }
  },
  'POST /api/admin/seo': (b) => {
    const metrika = str(b.metrika, 20).replace(/\D/g, ''), ywm = str(b.ywm, 200).replace(/^.*content=["']?([\w-]+).*$/s, '$1').replace(/[^\w-]/g, '').slice(0, 80);
    if (metrika && !/^\d{5,12}$/.test(metrika)) throw new UserError('Номер счётчика Метрики — это число из 5–12 цифр.');
    setSetting('seo', { metrika, ywm }); return { ok: true };
  },
  'POST /api/admin/docs': (b) => { setSetting('docs', { autoInvoice: !!b.autoInvoice, autoWaybill: !!b.autoWaybill }); return { ok: true }; },
  'POST /api/admin/yookassa': async (b) => {
    const old = getSetting('yk') || {};
    const cfg = { shop_id: str(b.shop_id, 20).replace(/\D/g, ''), secret: str(b.secret, 100).replace(/\s+/g, '') || old.secret || '',
      bank: posInt(b.bank) || null, receipt: !!b.receipt,
      tax: [1, 2, 3, 4, 5, 6].includes(Number(b.tax)) ? Number(b.tax) : 0, vat: [1, 2, 7, 8].includes(Number(b.vat)) ? Number(b.vat) : 1 };
    if (!cfg.shop_id) throw new UserError('Укажите shopId — число из настроек магазина в ЮKassa.');
    if (!/^(test|live)_[\w-]{10,}$/.test(cfg.secret)) throw new UserError('Секретный ключ начинается с live_ или test_. Скопируйте его целиком из раздела «Интеграция → Ключи API».');
    let me; try { me = await ykApi(cfg, 'GET', '/me'); } catch (e) { throw new UserError('Не получилось подключить: ' + e.message + '.'); }
    cfg.test = !!me.test || cfg.secret.startsWith('test_');
    setSetting('yk', cfg);
    return { test: cfg.test };
  },
  'POST /api/admin/yookassa/off': () => { db.prepare("DELETE FROM settings WHERE key = 'yk'").run(); return { ok: true }; },
  'POST /api/admin/mail/off': () => { db.prepare("DELETE FROM settings WHERE key = 'mail'").run(); return { ok: true }; },
  'POST /api/admin/telegram/off': () => { db.prepare("DELETE FROM settings WHERE key = 'tg'").run(); return { ok: true }; },
  'POST /api/admin/owner': (b) => {
    const o = {}; for (const k of Object.keys(DEFAULT_OWNER)) o[k] = str(b[k], 300);
    db.prepare("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(o));
    return { ok: true };
  },
};

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new UserError('Слишком большой запрос.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new UserError('Неверный формат запроса.')); } });
    req.on('error', reject);
  });
}
const ADMIN_HEAD = [
  ['<link rel="manifest" href="/manifest.webmanifest">', '<link rel="manifest" href="/manifest-admin.webmanifest">'],
  ['<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="/admin-apple-touch-icon.png">'],
  ['<meta name="theme-color" content="#151515">', '<meta name="theme-color" content="#EDECE8">'],
  ['<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">', '<meta name="apple-mobile-web-app-status-bar-style" content="default">'],
  ['<meta name="apple-mobile-web-app-title" content="Mebel Segment">', '<meta name="apple-mobile-web-app-title" content="MS Кабинет">'],
  [/<title>[^<]*<\/title>/, '<title>MS Кабинет</title>'],
];
const slug = sku => String(sku).toLowerCase().replace(/[^a-z0-9а-яё-]+/gi, '-');
const productUrl = p => `/tovar/${encodeURIComponent(slug(p.sku))}`;
const activeProducts = () => db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all();
const absPhoto = p => p.photo ? `${SITE_URL}/uploads/${p.photo}` : `${SITE_URL}/hero-hinge.jpg`;
// каталог прямо в HTML главной страницы — его видят поисковики и пользователи до загрузки скрипта
function catalogHtml() {
  const list = activeProducts();
  return `<div class="wrap seo-cat"><h1 class="caps">Мебельная фурнитура оптом — Mebel Segment, Ставрополь</h1>
<p class="muted">Загрузка каталога… Если страница не открывается, включите JavaScript или позвоните нам.</p>
<ul>${list.map(p => `<li><a href="${productUrl(p)}">${h(p.name)}</a> — ${h(p.sku)}, ${rubs(p.price)}${p.box ? `, в коробке ${p.box} ${h(p.unit)}` : ''}</li>`).join('')}</ul></div>`;
}
function serveIndex(res, admin) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Ошибка', 'text/plain; charset=utf-8');
    if (admin) {
      // По адресу /admin — та же страница, но с настройками приложения «MS Кабинет» прямо в HTML:
      // iPhone читает их при загрузке страницы и не видит подмену скриптом.
      for (const [from, to] of ADMIN_HEAD) html = html.replace(from, to);
      html = html.replace('</head>', '<meta name="robots" content="noindex"></head>');
    } else {
      const o = getOwner();
      const org = { '@context': 'https://schema.org', '@type': 'Store', name: 'Mebel Segment', url: SITE_URL, logo: SITE_URL + '/logo.png', image: SITE_URL + '/hero-hinge.jpg',
        telephone: o.phone || undefined, email: o.email || undefined, address: o.addr ? { '@type': 'PostalAddress', streetAddress: o.addr, addressCountry: 'RU' } : undefined };
      html = html.replace('</head>', `<link rel="canonical" href="${SITE_URL}/">
<meta property="og:type" content="website"><meta property="og:site_name" content="Mebel Segment"><meta property="og:title" content="Mebel Segment — мебельная фурнитура оптом">
<meta property="og:description" content="Петли с доводчиком, 3D-петли, шариковые направляющие и направляющие скрытого монтажа. Опт коробками и розница, Ставрополь.">
<meta property="og:image" content="${SITE_URL}/hero-hinge.jpg">${seoHead()}
<script type="application/ld+json">${JSON.stringify(org).replace(/</g, '\\u003c')}</script></head>`)
        .replace('<main id="app"><div class="wrap empty">Загрузка…</div></main>', `<main id="app">${catalogHtml()}</main>`)
        .replace('</body>', metrikaTag() + '</body>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(html);
  });
}
function renderProduct(p) {
  const same = activeProducts().filter(x => x.cat === p.cat && x.id !== p.id).slice(0, 6);
  const stock = p.stock > 0 ? 'В наличии' : 'Под заказ — срок подтвердит менеджер';
  const title = `${p.name}, артикул ${p.sku}`;
  const desc = `${p.name} — ${rubs(p.price)}${p.box ? `, в коробке ${p.box} ${p.unit}` : ''}. ${p.descr || ''} Опт и розница, счёт для юрлиц и ИП. Mebel Segment, Ставрополь.`.replace(/\s+/g, ' ').trim();
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.sku, category: p.cat, description: p.descr || p.name, image: absPhoto(p),
    brand: { '@type': 'Brand', name: 'Mebel Segment' },
    offers: { '@type': 'Offer', price: p.price.toFixed(2), priceCurrency: 'RUB', url: SITE_URL + productUrl(p), availability: 'https://schema.org/' + (p.stock > 0 ? 'InStock' : 'PreOrder') } };
  const css = `.prod{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.prod img{width:100%;border-radius:14px;background:#F2F1ED;aspect-ratio:1;object-fit:cover}
.price{font-size:30px;font-weight:bold;margin:10px 0}.btn{display:inline-block;border:0;background:#151515;color:#fff;font-weight:bold;padding:13px 22px;border-radius:999px;cursor:pointer;font-size:14px;text-decoration:none;margin:4px 6px 4px 0}
.btn.out{background:none;color:#151515;border:1.5px solid #151515}.crumbs{font-size:13px;color:#666;margin-bottom:10px}.crumbs a{color:#666}.same{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.same a{display:block;background:#F2F1ED;border-radius:12px;padding:12px;text-decoration:none;font-size:14px}@media(max-width:700px){.prod{grid-template-columns:1fr}}`;
  return pageShell(title, desc, productUrl(p), `<meta property="og:image" content="${hq(absPhoto(p))}"><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script><style>${css}</style>`) + `
<div class="card"><div class="crumbs"><a href="/">Главная</a> › <a href="/#catalog">Каталог</a> › ${h(p.cat)}</div>
<div class="prod"><div>${p.photo ? `<img src="/uploads/${hq(p.photo)}" alt="${hq(p.name)}">` : `<img src="/hero-hinge.jpg" alt="">`}</div>
<div><h1>${h(p.name)}</h1><div class="muted">Артикул ${h(p.sku)} · ${h(p.cat)}</div>
<div class="price">${rubs(p.price)} <span class="muted" style="font-size:15px;font-weight:normal">за ${h(p.unit)}</span></div>
<p><b>${stock}</b>${p.box ? `<br>В коробке: ${p.box} ${h(p.unit)} — ${rubs(r2(p.price * p.box))} за коробку` : ''}</p>
${p.descr ? `<p>${h(p.descr)}</p>` : ''}
<p><button class="btn" data-add="1">В корзину</button>${p.box ? `<button class="btn out" data-add="${p.box}">+ коробка ${p.box} ${h(p.unit)}</button>` : ''}</p>
<p class="muted">Цены в рублях, без НДС (УСН). Оплата картой, по СБП или по счёту для организаций. Самовывоз в Ставрополе или доставка транспортной компанией — <a href="/rekvizity#dostavka">условия</a>.</p></div></div></div>
${same.length ? `<div class="card"><h2>Ещё в разделе «${h(p.cat)}»</h2><div class="same">${same.map(x => `<a href="${productUrl(x)}">${h(x.name)}<br><b>${rubs(x.price)}</b></a>`).join('')}</div></div>` : ''}
<script>document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{let c={};try{c=JSON.parse(localStorage.getItem('cart'))||{}}catch(e){}
c[${p.id}]=(c[${p.id}]||0)+Number(b.dataset.add);try{localStorage.setItem('cart',JSON.stringify(c))}catch(e){}location.href='/?cart=1#catalog'})</script>
` + pageEnd();
}
function robotsTxt() {
  return `User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /doc/\nDisallow: /*?pay=\nDisallow: /*?reset=\nClean-param: source&cart /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}
function sitemapXml() {
  const urls = [['/', '1.0'], ['/rekvizity', '0.3'], ['/privacy', '0.2'], ['/soglasie', '0.2'], ...activeProducts().map(p => [productUrl(p), '0.8'])];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, pr]) => `<url><loc>${SITE_URL}${u}</loc><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`;
}
function sendHtml(res, html, code = 200) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(html); }
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/admin' || p === '/admin/') return serveIndex(res, true);
  if (p === '/' || p === '/index.html') return serveIndex(res, false);
  if (p === '/robots.txt') return send(res, 200, robotsTxt(), 'text/plain; charset=utf-8');
  if (p === '/sitemap.xml') return send(res, 200, sitemapXml(), 'application/xml; charset=utf-8');
  const tm = p.match(/^\/tovar\/([^/]+)\/?$/);
  if (tm) { const pr = activeProducts().find(x => slug(x.sku) === tm[1].toLowerCase()); return pr ? sendHtml(res, renderProduct(pr)) : sendHtml(res, pageShell('Товар не найден', 'Товар не найден', '/') + '<div class="card"><h1>Товар не найден</h1><p>Возможно, его убрали из каталога. <a href="/#catalog">Перейти в каталог</a></p></div>' + pageEnd(), 404); }
  const page = { '/rekvizity': renderInfo, '/oferta': renderInfo, '/privacy': renderPrivacy, '/soglasie': renderConsent }[p.replace(/\/$/, '') || '/'];
  if (page) return sendHtml(res, page());
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p.startsWith('/fonts/') ? 'public, max-age=2592000' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // защита от встраивания сайта в чужие страницы (кликджекинг) и утечки адресов страниц на сторонние сайты
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  let url; try { url = new URL(req.url, 'http://local'); } catch { return send(res, 400, 'Bad request', 'text/plain'); }
  const key = `${req.method} ${url.pathname}`;
  try {
    const dm = url.pathname.match(/^\/doc\/(invoice|waybill)\/(\d+)$/);
    if (dm && req.method === 'GET') {
      const k = url.searchParams.get('k') || '', want = docSig(dm[1], Number(dm[2]));
      if (k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return send(res, 404, 'Документ не найден', 'text/plain; charset=utf-8');
      const [inv] = invoiceRows('WHERE id = ?', Number(dm[2]));
      if (!inv || (dm[1] === 'waybill' && !inv.shipped)) return send(res, 404, 'Документ не найден', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' });
      return res.end(renderDoc(dm[1], inv));
    }
    if (url.pathname.startsWith('/uploads/')) {
      const name = url.pathname.slice(9);
      if (!/^[0-9]+-[0-9a-f]{12}\.(jpg|png|webp)$/.test(name)) return send(res, 404, 'Not found', 'text/plain');
      return fs.readFile(path.join(UPLOADS, name), (err, data) => {
        if (err) return send(res, 404, 'Not found', 'text/plain');
        res.writeHead(200, { 'Content-Type': MIME['.' + name.split('.').pop()], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        res.end(data);
      });
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Метод не поддерживается.' });
      return serveStatic(req, res, url.pathname);
    }
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'Не найдено.' });
    if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) return send(res, 401, { error: 'Войдите в кабинет.' });
    if (req.method === 'POST') {
      // защита от отправки форм с чужих сайтов
      const origin = req.headers.origin;
      let host = null; try { host = origin ? new URL(origin).host : null; } catch {}
      if (origin && key !== 'POST /api/yookassa/webhook' && host !== req.headers.host) return send(res, 403, { error: 'Запрос отклонён.' });
    }
    const body = req.method === 'POST' ? await readBody(req, key === 'POST /api/admin/products/photo' || key === 'POST /api/admin/statement' ? 12 * 1024 * 1024 : 256 * 1024) : {};
    send(res, 200, await handler(body, req, res, url));
  } catch (e) {
    if (e instanceof UserError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Мебель Сегмент: http://127.0.0.1:${PORT}`));
