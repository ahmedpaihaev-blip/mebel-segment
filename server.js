'use strict';
// Мебель Сегмент: магазин фурнитуры и кабинет владельца.
// Без внешних зависимостей: Node.js 22+ (http, crypto, node:sqlite).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

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
`);

// Первичное наполнение: банки владельца и примерный каталог (меняется в кабинете).
if (!db.prepare('SELECT COUNT(*) c FROM banks').get().c) {
  const ins = db.prepare('INSERT INTO banks (name, acc, balance) VALUES (?, ?, 0)');
  for (const n of ['Альфа-Банк', 'Сбербанк', 'Россельхозбанк']) ins.run(n, '');
}
if (!db.prepare('SELECT COUNT(*) c FROM products').get().c) {
  const ins = db.prepare('INSERT INTO products (sku, name, cat, unit, price, stock) VALUES (?, ?, ?, ?, ?, ?)');
  [
    ['HNG-110', 'Петля накладная 110° с доводчиком', 'Петли', 'шт', 145, 0],
    ['HNG-165', 'Петля вкладная 165° для угловых шкафов', 'Петли', 'шт', 210, 0],
    ['SLD-350', 'Направляющие шариковые 350 мм', 'Направляющие', 'компл.', 390, 0],
    ['SLD-500T', 'Направляющие скрытые 500 мм, push-to-open', 'Направляющие', 'компл.', 1850, 0],
    ['HDL-128B', 'Ручка-скоба 128 мм, латунь', 'Ручки', 'шт', 260, 0],
    ['HDL-160G', 'Ручка-рейлинг 160 мм, графит', 'Ручки', 'шт', 190, 0],
    ['LFT-100N', 'Подъёмник газовый 100 N', 'Подъёмники', 'шт', 320, 0],
    ['LEG-100', 'Опора регулируемая 100 мм', 'Опоры', 'шт', 95, 0],
  ].forEach(r => ins.run(...r));
}
const DEFAULT_OWNER = { name: '', inn: '', ogrnip: '', addr: '', bank: '', acc: '', bik: '', ks: '', phone: '', email: '' };
const getOwner = () => {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'owner'").get();
  return { ...DEFAULT_OWNER, ...(r ? JSON.parse(r.value) : {}) };
};

const CATS = ['Петли', 'Направляющие', 'Ручки', 'Подъёмники', 'Опоры', 'Прочее'];
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
const sessions = new Map();
const loginFails = new Map();
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAdmin(req) {
  const t = cookies(req).sid; const s = t && sessions.get(t);
  if (!s) return false;
  if (s.exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
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
    cats: CATS,
    products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY cat, name').all(),
    banks: db.prepare('SELECT * FROM banks ORDER BY id').all(),
    txns: db.prepare('SELECT * FROM txns ORDER BY id DESC LIMIT 300').all(),
    invoices: invoiceRows(),
    orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300').all(),
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

/* ---------- маршруты ---------- */
const routes = {
  'GET /api/catalog': () => ({
    cats: CATS,
    owner: (({ phone, email }) => ({ phone, email }))(getOwner()),
    products: db.prepare('SELECT id, sku, name, cat, unit, price, stock FROM products WHERE active = 1 ORDER BY cat, name').all(),
  }),
  'POST /api/orders': (b) => tx(() => {
    const client = str(b.name, 120), phone = str(b.phone, 40), inn = str(b.inn, 12).replace(/\D/g, ''), comment = str(b.comment, 500);
    if (!client || phone.replace(/\D/g, '').length < 10) throw new UserError('Укажите имя и телефон из 10–11 цифр.');
    const items = readItems(b.items, false);
    for (const x of items) if (x.qty > x.p.stock) throw new UserError(`«${x.p.name}»: на складе только ${x.p.stock} ${x.p.unit}.`);
    const o = db.prepare('INSERT INTO orders (date, client, phone, inn, comment) VALUES (?, ?, ?, ?, ?)').run(now(), client, phone, inn || null, comment || null);
    const invId = createInvoice({ client, inn, items, orderId: Number(o.lastInsertRowid) });
    return { order: Number(o.lastInsertRowid), invoice: invId, sum: r2(items.reduce((s, x) => s + x.qty * x.p.price, 0)) };
  }),
  'POST /api/login': (b, req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const f = loginFails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new UserError('Слишком много попыток. Подождите 10 минут.', 429);
    if (!ADMIN_PASSWORD || !safeEqual(str(b.password, 200), ADMIN_PASSWORD)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }
      loginFails.set(ip, f);
      throw new UserError('Неверный пароль.', 401);
    }
    loginFails.delete(ip);
    const t = crypto.randomBytes(32).toString('hex');
    sessions.set(t, { exp: Date.now() + SESSION_TTL });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}`);
    return { ok: true };
  },
  'POST /api/logout': (b, req, res) => {
    sessions.delete(cookies(req).sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  },
  'GET /api/admin/state': () => adminState(),
  'POST /api/admin/invoices': (b) => tx(() => {
    const client = str(b.client, 160); if (!client) throw new UserError('Укажите покупателя.');
    return { id: createInvoice({ client, inn: str(b.inn, 12).replace(/\D/g, ''), items: readItems(b.items, false) }) };
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
    db.prepare('UPDATE invoices SET shipped = 1 WHERE id = ?').run(inv.id);
    if (inv.order_id) db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(inv.order_id);
    return { ok: true };
  }),
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
    if (!sku || !name || !(price > 0)) throw new UserError('Заполните артикул, название и цену.');
    if (b.id) {
      const r = db.prepare('UPDATE products SET sku = ?, name = ?, cat = ?, unit = ?, price = ? WHERE id = ? AND active = 1').run(sku, name, cat, unit, price, posInt(b.id));
      if (!r.changes) throw new UserError('Товар не найден.', 404);
      return { id: posInt(b.id) };
    }
    return { id: Number(db.prepare('INSERT INTO products (sku, name, cat, unit, price) VALUES (?, ?, ?, ?, ?)').run(sku, name, cat, unit, price).lastInsertRowid) };
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
  'POST /api/admin/owner': (b) => {
    const o = {}; for (const k of Object.keys(DEFAULT_OWNER)) o[k] = str(b[k], 300);
    db.prepare("INSERT INTO settings (key, value) VALUES ('owner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(o));
    return { ok: true };
  },
};

/* ---------- http ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 256 * 1024) { reject(new UserError('Слишком большой запрос.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new UserError('Неверный формат запроса.')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p === '/' || p === '/admin') p = '/index.html';
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
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Запрос отклонён.' });
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await handler(body, req, res));
  } catch (e) {
    if (e instanceof UserError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Мебель Сегмент: http://127.0.0.1:${PORT}`));
