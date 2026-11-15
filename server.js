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
`);
for (const [table, col, type] of [['products', 'photo', 'TEXT'], ['products', 'box', 'INTEGER'], ['products', 'descr', 'TEXT'], ['orders', 'customer_id', 'INTEGER'], ['invoices', 'email', 'TEXT'], ['invoices', 'shipped_at', 'TEXT']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
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
    yk: (y => y ? { shop_id: y.shop_id, test: !!y.test, bank: y.bank, receipt: !!y.receipt } : null)(ykCfg()),
    mail: (m => m ? { host: m.host, port: m.port, user: m.user, to: m.to || '', ok: !!m.pass } : null)(getSetting('mail')),
    tg: (t => t ? { bot: t.bot || '', linked: !!t.chat_id, chat: t.chat_name || '' } : null)(getSetting('tg')),
    cats: CATS,
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all(),
    banks: db.prepare('SELECT * FROM banks ORDER BY id').all(),
    txns: db.prepare('SELECT * FROM txns ORDER BY id DESC LIMIT 300').all(),
    invoices: invoiceRows().map(i => ({ ...i, links: docLinks(i) })),
    docs: docsCfg(),
    backup: { ...backupCfg(), last: getSetting('backup_last') },
    orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all(),
    customers: db.prepare(`SELECT c.id, c.email, c.name, c.phone, c.company, c.inn, c.created,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS orders,
        (SELECT COALESCE(SUM(ii.qty * ii.price), 0) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN orders o ON o.id = i.order_id
          WHERE o.customer_id = c.id AND i.status != 'cancelled') AS total,
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
async function startPayment(invoiceId) {
  const cfg = ykCfg(); if (!cfg) throw new UserError('Онлайн-оплата пока не подключена. Оплатите по счёту.');
  const [inv] = invoiceRows('WHERE id = ?', invoiceId);
  if (!inv) throw new UserError('Счёт не найден.', 404);
  if (inv.status !== 'issued') throw new UserError(inv.status === 'paid' ? 'Этот заказ уже оплачен.' : 'Этот счёт отменён.');
  const o = inv.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(inv.order_id) : null;
  const c = o && o.customer_id ? db.prepare('SELECT email FROM customers WHERE id = ?').get(o.customer_id) : null;
  const token = crypto.randomBytes(16).toString('hex');
  const body = {
    amount: { value: inv.sum.toFixed(2), currency: 'RUB' }, capture: true,
    confirmation: { type: 'redirect', return_url: `${SITE_URL}/?pay=${token}` },
    description: `Заказ №${o ? o.id : inv.id} на mebel-segment.ru`.slice(0, 128),
    metadata: { invoice_id: String(inv.id), order_id: String(o ? o.id : '') },
  };
  if (cfg.receipt) { // данные для чека по 54-ФЗ («Чеки от ЮKassa» или подключённая касса)
    const ph = digits(o && o.phone);
    body.receipt = { customer: c ? { email: c.email } : ph.length === 11 ? { phone: ph } : {},
      items: inv.items.map(x => ({ description: x.name.slice(0, 128), quantity: String(x.qty), amount: { value: x.price.toFixed(2), currency: 'RUB' },
        vat_code: 1, payment_mode: 'full_payment', payment_subject: 'commodity' })) };
  }
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


/* ---------- страница «Реквизиты и условия» (требуется ЮKassa и банками) ---------- */
function renderInfo() {
  const o = getOwner(), e = v => h(v || '');
  const fio = (o.name || '').replace(/^ИП\s*/i, '');
  const req = [['Продавец', o.name || 'Индивидуальный предприниматель'], ['ИНН', o.inn], ['ОГРНИП', o.ogrnip], ['Адрес', o.addr],
    ['Телефон', o.phone], ['Почта', o.email], ['Расчётный счёт', o.acc], ['Банк', o.bank], ['БИК', o.bik], ['Корр. счёт', o.ks]].filter(([, v]) => v);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Реквизиты и условия — Mebel Segment</title><meta name="description" content="Реквизиты продавца, условия оплаты, доставки и возврата, публичная оферта Mebel Segment.">
<link rel="icon" href="/favicon.png"><style>
*{box-sizing:border-box}body{margin:0;background:#E8E7E3;color:#151515;font:15px/1.6 Arial,Helvetica,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:16px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0 20px}
header img{height:34px}header a{color:#151515;font-weight:bold;text-decoration:none;font-size:14px}
.card{background:#fff;border-radius:18px;padding:24px 28px;margin-bottom:14px}h1{font-size:28px;margin:0 0 6px}h2{font-size:19px;margin:0 0 10px}
table{border-collapse:collapse;width:100%}td{padding:7px 0;border-bottom:1px solid #eee;vertical-align:top}td:first-child{color:#666;width:200px;padding-right:12px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}nav a{border:1.5px solid #151515;border-radius:999px;padding:5px 14px;color:#151515;text-decoration:none;font-size:13px;font-weight:bold}
ol,ul{padding-left:20px}li{margin:4px 0}.muted{color:#666;font-size:13px}@media(max-width:600px){td:first-child{width:120px}.card{padding:18px}}
</style></head><body><div class="wrap">
<header><a href="/"><img src="/logo.png" alt="Mebel Segment"></a><a href="/#catalog">← В каталог</a></header>
<div class="card"><h1>Реквизиты и условия</h1><p class="muted">Интернет-магазин мебельной фурнитуры mebel-segment.ru</p>
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
<div class="card" id="dannye"><h2>Обработка персональных данных</h2>
<p>Оформляя заказ или регистрируясь на сайте, покупатель соглашается на обработку Продавцом своих персональных данных (имя, телефон, почта, адрес доставки, ИНН) в целях исполнения заказа, связи с покупателем и выставления документов, в соответствии с Федеральным законом № 152-ФЗ «О персональных данных». Данные не передаются третьим лицам, кроме случаев, необходимых для доставки и оплаты заказа. Покупатель может отозвать согласие, написав Продавцу${o.email ? ' на ' + e(o.email) : ''}.</p></div>
<p class="muted" style="text-align:center">© ${new Date().getFullYear()} ${e(o.name || 'Mebel Segment')}${fio ? '' : ''} · mebel-segment.ru</p>
</div></body></html>`;
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
async function sendBackup() {
  const m = mailCfg(); if (!m || !m.to) throw new UserError('Сначала подключите почту: «Настройки» → «Почта».');
  const tmp = path.join(DATA_DIR, `backup-${process.pid}-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // согласованная копия без остановки сайта
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 9 });
    const day = new Date().toLocaleDateString('ru-RU'), stamp = new Date().toISOString().slice(0, 10);
    const cnt = t => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    await smtpSend(m, m.to, `Копия базы Mebel Segment за ${day}`, mailWrap(`Копия базы за ${day}`,
      `<p>Во вложении — полная копия данных сайта: товары, остатки, заказы, счета, клиенты, банки и настройки.</p>
       <p style="color:#555">Сейчас в базе: товаров ${db.prepare('SELECT COUNT(*) c FROM products WHERE active = 1').get().c}, заказов ${cnt('orders')}, счетов ${cnt('invoices')}, клиентов ${cnt('customers')}.</p>
       <p style="color:#8a8984;font-size:13px">Храните эти письма — из любого из них можно восстановить сайт. Фотографии товаров в копию не входят. В файле есть личные данные клиентов: не пересылайте его посторонним.</p>`),
      [{ name: `mebel-segment-${stamp}.db.gz`, type: 'application/gzip', content: gz }]);
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
    const tags = [b.kind === 'company' ? 'Организация / ИП' : 'Частное лицо', b.delivery === 'delivery' ? 'Доставка' : 'Самовывоз'];
    const comment = [tags.join(' · '), str(b.comment, 500)].filter(Boolean).join('. ');
    // товар без остатка можно заказать «под заказ»: владелец подтвердит срок, списание — только при отгрузке
    const email = normEmail(b.email) || (me ? me.email : '');
    if (email && !validEmail(email)) throw new UserError('Проверьте адрес почты.');
    const items = readItems(b.items, false);
    const o = db.prepare('INSERT INTO orders (date, client, phone, inn, comment, customer_id) VALUES (?, ?, ?, ?, ?, ?)').run(now(), client, phone, inn || null, comment || null, me ? me.id : null);
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
    if (db.prepare('SELECT 1 FROM customers WHERE email = ?').get(email)) throw new UserError('Эта почта уже зарегистрирована. Войдите или попросите сбросить пароль.', 409);
    const id = Number(db.prepare('INSERT INTO customers (email, pass, name, phone, company, inn, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(email, hashPass(pw), name, phone, str(b.company, 160), str(b.inn, 12).replace(/\D/g, ''), now()).lastInsertRowid);
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
    const live = list.filter(o => o.invoice && o.invoice.status !== 'cancelled');
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
    if (inv.status === 'paid') throw new UserError('Счёт уже оплачен.');
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
    if (inv.status === 'paid' || inv.shipped) throw new UserError('Оплаченный или отгруженный счёт отменить нельзя.');
    db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(inv.id);
    if (inv.order_id) db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(inv.order_id);
    return { ok: true };
  }),
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
  'POST /api/admin/docs': (b) => { setSetting('docs', { autoInvoice: !!b.autoInvoice, autoWaybill: !!b.autoWaybill }); return { ok: true }; },
  'POST /api/admin/yookassa': async (b) => {
    const old = getSetting('yk') || {};
    const cfg = { shop_id: str(b.shop_id, 20).replace(/\D/g, ''), secret: str(b.secret, 100).replace(/\s+/g, '') || old.secret || '',
      bank: posInt(b.bank) || null, receipt: !!b.receipt };
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
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
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
// По адресу /admin — та же страница, но с настройками приложения «MS Кабинет» прямо в HTML:
// iPhone читает их при загрузке страницы и не видит подмену скриптом.
const ADMIN_HEAD = [
  ['<link rel="manifest" href="/manifest.webmanifest">', '<link rel="manifest" href="/manifest-admin.webmanifest">'],
  ['<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="apple-touch-icon" href="/admin-apple-touch-icon.png">'],
  ['<meta name="theme-color" content="#151515">', '<meta name="theme-color" content="#EDECE8">'],
  ['<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">', '<meta name="apple-mobile-web-app-status-bar-style" content="default">'],
  ['<meta name="apple-mobile-web-app-title" content="Mebel Segment">', '<meta name="apple-mobile-web-app-title" content="MS Кабинет">'],
  [/<title>[^<]*<\/title>/, '<title>MS Кабинет</title>'],
];
function serveAdminPage(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Ошибка', 'text/plain; charset=utf-8');
    for (const [from, to] of ADMIN_HEAD) html = html.replace(from, to);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(html);
  });
}
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/admin' || p === '/admin/') return serveAdminPage(res);
  if (p === '/rekvizity' || p === '/rekvizity/' || p === '/oferta') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(renderInfo()); }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
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
      if (origin && key !== 'POST /api/yookassa/webhook' && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Запрос отклонён.' });
    }
    const body = req.method === 'POST' ? await readBody(req, key === 'POST /api/admin/products/photo' ? 12 * 1024 * 1024 : 256 * 1024) : {};
    send(res, 200, await handler(body, req, res, url));
  } catch (e) {
    if (e instanceof UserError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Мебель Сегмент: http://127.0.0.1:${PORT}`));
