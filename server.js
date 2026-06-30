// server.js — Refael Fashion | Unified Node.js + Express backend (NO payment gateway)
// Run: npm i express && node server.js  →  http://localhost:3000  (admin: /admin)
'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const express = require('express');

const app = express();
app.use(express.json({ limit: '16mb' })); // allow base64 image uploads from the admin

/* =========================================================================
 * 1) CATALOG + SIZE CONSTANTS  (single source of truth, in server state)
 * ========================================================================= */
const SIZE_GROUPS = { KIDS: 'kids', YOUTH: 'youth', SHOES: 'shoes', COMBINED: 'combined', ONE_SIZE: 'one_size' };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
const SIZES_BY_GROUP = {
  [SIZE_GROUPS.KIDS]: range(0, 7),       // ילדים 0–7
  [SIZE_GROUPS.YOUTH]: range(8, 22),     // נוער 8–22
  [SIZE_GROUPS.SHOES]: range(20, 46),    // נעליים 20–46
  [SIZE_GROUPS.COMBINED]: range(0, 22),  // משולב 0–22
  [SIZE_GROUPS.ONE_SIZE]: ['ONE_SIZE'],  // מידה אחת
};
const isOneSize = (g) => g === SIZE_GROUPS.ONE_SIZE;
const sizesFor = (g) => SIZES_BY_GROUP[g] || [];

const PRODUCTS = [
  { id: 'suit-kids',          name: 'חליפת ילדים',        category: 'חליפות',   price: 550, sizeGroup: SIZE_GROUPS.KIDS },
  { id: 'suit-youth',         name: 'חליפת נוער',         category: 'חליפות',   price: 650, sizeGroup: SIZE_GROUPS.YOUTH },
  { id: 'linen-shirt-kids',   name: 'מכופתרת פשתן ילד',   category: 'מכופתרות', price: 249, sizeGroup: SIZE_GROUPS.KIDS },
  { id: 'shirt-regular',      name: 'מכופתרת רגילה',      category: 'מכופתרות', price: 199, sizeGroup: SIZE_GROUPS.COMBINED },
  { id: 'linen-pants-kids',   name: 'מכנס פשתן ילדים',    category: 'מכנסיים',  price: 249, sizeGroup: SIZE_GROUPS.KIDS },
  { id: 'linen-pants-youth',  name: 'מכנס פשתן נוער',     category: 'מכנסיים',  price: 279, sizeGroup: SIZE_GROUPS.YOUTH },
  { id: 'parade-pants-kids',  name: 'מכנס ילדים פרדה',    category: 'מכנסיים',  price: 249, sizeGroup: SIZE_GROUPS.KIDS },
  { id: 'parade-pants-youth', name: 'מכנס נוער פרדה',     category: 'מכנסיים',  price: 279, sizeGroup: SIZE_GROUPS.YOUTH },
  { id: 'oversized-pants-kids',  name: 'מכנס אוברסייז ילדים', category: 'מכנסיים', price: 249, sizeGroup: SIZE_GROUPS.KIDS },
  { id: 'oversized-pants-youth', name: 'מכנס אוברסייז נוער',  category: 'מכנסיים', price: 279, sizeGroup: SIZE_GROUPS.YOUTH },
  { id: 'vest',               name: 'וסט נוער וילדים',    category: 'וסטים',    price: 199, sizeGroup: SIZE_GROUPS.COMBINED },
  { id: 'shoes',              name: 'נעליים',             category: 'אביזרים',  price: 249, sizeGroup: SIZE_GROUPS.SHOES },
  { id: 'belt',               name: 'חגורות',             category: 'אביזרים',  price: 70,  sizeGroup: SIZE_GROUPS.ONE_SIZE },
  { id: 'bowtie',             name: 'פפיון',              category: 'אביזרים',  price: 39,  sizeGroup: SIZE_GROUPS.ONE_SIZE },
];

// Live in-memory catalog the admin can mutate.
const CATALOG = PRODUCTS.map((p) => ({
  ...p,
  oneSize: isOneSize(p.sizeGroup),
  sizes: sizesFor(p.sizeGroup),
  stockStatus: 'in_stock',
}));
const productById = new Map(CATALOG.map((p) => [p.id, p]));

function isValidSize(product, size) {
  if (!product) return false;
  if (product.oneSize) return true;
  return sizesFor(product.sizeGroup).includes(String(size));
}

/* =========================================================================
 * 2) SHIPPING  (server-side source of truth)
 * ========================================================================= */
const SHIPPING_METHODS = { COURIER: 'courier', SELF_PICKUP: 'self_pickup' };

/* Editable store settings (admin can change these live; used by the logic below). */
const SETTINGS = {
  freeThreshold: 1500,
  flatFee: 40,
  studioAddress: 'הבונים 3, נתניה',
  ownerPhone: process.env.OWNER_PHONE || '0546398638',
  whatsapp: '972546398638',
  smsSender: process.env.SMS_SENDER || 'Rafael',
  bannerHe: 'חליפות לבר מצווה · חליפות לשושבינים · חליפות לחתונות',
  bannerEn: 'Bar Mitzvah Suits · Groomsmen Suits · Wedding Suits',
  bannerFr: "Costumes Bar Mitzvah · Costumes Garçons d'honneur · Costumes de Mariage",
};

const isValidMethod = (m) => Object.values(SHIPPING_METHODS).includes(m);

function calcShippingFee(method, subtotal) {
  if (method === SHIPPING_METHODS.SELF_PICKUP) return 0;
  if (Number(subtotal) >= SETTINGS.freeThreshold) return 0;
  return SETTINGS.flatFee;
}
function amountToFreeShipping(method, subtotal) {
  if (method === SHIPPING_METHODS.SELF_PICKUP) return 0;
  const r = SETTINGS.freeThreshold - Number(subtotal);
  return r > 0 ? Math.ceil(r) : 0;
}
function shippingMessage(method, subtotal) {
  if (method === SHIPPING_METHODS.SELF_PICKUP) return 'איסוף עצמי מהסטודיו – ללא דמי משלוח';
  const r = amountToFreeShipping(method, subtotal);
  return r > 0 ? `עוד ₪${r} למשלוח חינם` : 'זכאי/ת למשלוח חינם – המשלוח עלינו';
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Build authoritative line items from a client cart; prices ALWAYS from the catalog.
function buildLineItems(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) return { error: 'העגלה ריקה' };
  const items = [];
  for (const raw of cartItems) {
    const product = productById.get(String(raw.productId));
    if (!product) return { error: `מוצר לא קיים: ${raw.productId}` };
    if (product.stockStatus === 'out_of_stock') return { error: `${product.name} אזל מהמלאי` };
    const size = product.oneSize ? 'ONE_SIZE' : String(raw.size ?? '');
    if (!product.oneSize && !size) return { error: `יש לבחור מידה עבור ${product.name}` };
    if (!isValidSize(product, size)) return { error: `מידה לא תקינה עבור ${product.name}` };
    const quantity = Math.max(1, parseInt(raw.quantity, 10) || 1);
    items.push({ productId: product.id, name: product.name, size, quantity, price: product.price });
  }
  return { items };
}

function computeTotals(method, items) {
  const subtotal = items.reduce((s, it) => s + it.price * it.quantity, 0);
  const shipping = calcShippingFee(method, subtotal);
  return {
    subtotal: round2(subtotal),
    shipping: round2(shipping),
    grandTotal: round2(subtotal + shipping),
    remainingForFreeShipping: amountToFreeShipping(method, subtotal),
    shippingMessage: shippingMessage(method, subtotal),
  };
}

/* =========================================================================
 * 3) VALIDATION
 * ========================================================================= */
const ISRAELI_MOBILE = /^05\d{8}$/;
const normalizePhone = (raw) => String(raw || '').replace(/\D/g, '');
const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

function validateCustomer(payload) {
  const errors = {};
  const c = payload.customer || {};
  const method = payload.shippingMethod;

  if (!String(c.firstName || '').trim()) errors.firstName = 'שם פרטי הוא שדה חובה';
  if (!String(c.lastName || '').trim()) errors.lastName = 'שם משפחה הוא שדה חובה';

  const phone = normalizePhone(c.phone);
  if (!phone) errors.phone = 'מספר טלפון הוא שדה חובה';
  else if (!ISRAELI_MOBILE.test(phone)) errors.phone = 'מספר נייד לא תקין (פורמט 05X-XXXXXXX)';

  if (!String(c.email || '').trim()) errors.email = 'אימייל הוא שדה חובה';
  else if (!isValidEmail(c.email)) errors.email = 'כתובת אימייל לא תקינה';

  if (!isValidMethod(method)) errors.shippingMethod = 'יש לבחור שיטת משלוח';

  // Address required ONLY for courier.
  if (method === SHIPPING_METHODS.COURIER) {
    if (!String(c.city || '').trim()) errors.city = 'עיר / יישוב הוא שדה חובה';
    if (!String(c.street || '').trim()) errors.street = 'רחוב הוא שדה חובה';
    if (!String(c.houseNumber || '').trim()) errors.houseNumber = 'מספר בית הוא שדה חובה';
  }

  const customer = {
    firstName: String(c.firstName || '').trim(),
    lastName: String(c.lastName || '').trim(),
    fullName: `${String(c.firstName || '').trim()} ${String(c.lastName || '').trim()}`.trim(),
    phone,
    email: String(c.email || '').trim(),
    notes: String(c.notes || '').trim(),
    ...(method === SHIPPING_METHODS.COURIER
      ? {
          city: String(c.city || '').trim(),
          street: String(c.street || '').trim(),
          houseNumber: String(c.houseNumber || '').trim(),
          entrance: String(c.entrance || '').trim(),
          floor: String(c.floor || '').trim(),
          apartment: String(c.apartment || '').trim(),
          zip: String(c.zip || '').trim(),
        }
      : {}),
  };
  return { ok: Object.keys(errors).length === 0, errors, customer };
}

// Payment scenario derived from shipping method (server-side).
function paymentFor(method) {
  return method === SHIPPING_METHODS.SELF_PICKUP
    ? { paymentMethod: 'studio_cash', status: 'pending_pickup_cash', label: 'תשלום בסטודיו בעת האיסוף' }
    : { paymentMethod: 'courier_cash', status: 'pending_cash', label: 'מזומן לשליח' };
}

/* =========================================================================
 * 4) IN-MEMORY ORDER STORE  (swap for a real DB / JSON file later)
 * ========================================================================= */
const orders = [];
let orderSeq = 1000;
const orderRepository = {
  create(order) {
    const created = { id: `RF-${++orderSeq}`, ...order };
    orders.push(created);
    return created;
  },
  getById(id) {
    return orders.find((o) => o.id === id) || null;
  },
};

/* =========================================================================
 * 4b) SMS NOTIFICATIONS
 *   SECRET — keep server-side only. Prefer setting SMS_API_KEY in the env.
 *   PUBLIC_URL must be your real public domain for SMS links to open on a phone
 *   (localhost links won't work on a customer's device).
 * ========================================================================= */
const PORT = process.env.PORT || 3000;
const SMS_API_KEY = process.env.SMS_API_KEY || '0XB736D664890D32C955F2E141D5FE136FE5A92EF012B802A0CEEAB0A4FB951C87471A7B1617BF02F829C48124BA17DAD0';
const PUBLIC_URL  = process.env.PUBLIC_URL  || `http://localhost:${PORT}`;

// Sends one SMS via ActiveTrail (api/smscampaign/OperationalMessage).
// Never throws — failures are logged so an order is never blocked by SMS.
function sendSMS(to, text) {
  if (!to) return Promise.resolve();
  console.log(`[SMS → ${to}] ${text.replace(/\n/g, ' ')}`);
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({
        details: { name: 'Rafael Order ' + Date.now(), from_name: SETTINGS.smsSender, content: text, can_unsubscribe: false },
        scheduling: { send_now: true },
        mobiles: [{ phone_number: String(to) }],
      });
      const req = https.request({
        method: 'POST',
        hostname: 'webapi.mymarketing.co.il',
        path: '/api/smscampaign/OperationalMessage',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': SMS_API_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) console.log(`[SMS ✓ ${to}] ${res.statusCode}`);
          else console.warn(`[SMS ✗ ${to}] ${res.statusCode} ${String(d).slice(0, 200)}`);
          resolve();
        });
      });
      req.on('error', (e) => { console.warn('[SMS error]', e.message); resolve(); });
      req.write(body);
      req.end();
    } catch (e) { console.warn('[SMS exception]', e.message); resolve(); }
  });
}

// Fire both notifications for a new order (never blocks/breaks the order on failure).
function notifyOrder(order) {
  try {
    sendSMS(order.customer.phone, `RAFAEL · ההזמנה התקבלה בהצלחה! 🤍\nלפרטי ההזמנה: ${PUBLIC_URL}/order?id=${order.id}`);
    sendSMS(SETTINGS.ownerPhone, `RAFAEL · הזמנה חדשה התקבלה (${order.id}).\nלניהול ההזמנה: ${PUBLIC_URL}/admin`);
  } catch (e) { console.error('notifyOrder error', e.message); }
}

/* =========================================================================
 * 5) ENDPOINTS — STOREFRONT / API
 * ========================================================================= */
app.get('/api/catalog', (_req, res) => res.json({ products: CATALOG }));

// Public settings the storefront uses (banner, shipping rules, prices, contact).
app.get('/api/settings', (_req, res) => res.json({
  bannerHe: SETTINGS.bannerHe, bannerEn: SETTINGS.bannerEn, bannerFr: SETTINGS.bannerFr,
  freeThreshold: SETTINGS.freeThreshold, flatFee: SETTINGS.flatFee,
  studioAddress: SETTINGS.studioAddress, whatsapp: SETTINGS.whatsapp,
  prices: priceMap(),
}));

// Live totals for the cart UI.
app.post('/api/checkout/quote', (req, res) => {
  try {
    const method = isValidMethod(req.body && req.body.shippingMethod) ? req.body.shippingMethod : SHIPPING_METHODS.COURIER;
    const built = buildLineItems(req.body && req.body.items);
    if (built.error) return res.status(400).json({ error: built.error });
    const totals = computeTotals(method, built.items);
    return res.json({ shippingMethod: method, payment: paymentFor(method), ...totals });
  } catch (err) {
    console.error('quote error', err.message);
    return res.status(500).json({ error: 'שגיאה בחישוב העגלה' });
  }
});

// Validate, compute final price, create the order.
app.post('/api/checkout/submit', (req, res) => {
  try {
    const method = req.body && req.body.shippingMethod;
    if (!isValidMethod(method)) return res.status(400).json({ error: 'יש לבחור שיטת משלוח' });

    const { ok, errors, customer } = validateCustomer(req.body);
    if (!ok) return res.status(422).json({ error: 'טופס לא תקין', fields: errors });

    const built = buildLineItems(req.body && req.body.items);
    if (built.error) return res.status(400).json({ error: built.error });

    const totals = computeTotals(method, built.items);
    const pay = paymentFor(method);

    const order = orderRepository.create({
      status: pay.status,
      paymentMethod: pay.paymentMethod,
      paymentLabel: pay.label,
      shippingMethod: method,
      customer,
      items: built.items,
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      grandTotal: totals.grandTotal,
      createdAt: new Date().toISOString(),
    });
    notifyOrder(order);

    return res.status(201).json({
      ok: true,
      orderId: order.id,
      status: order.status,
      paymentLabel: order.paymentLabel,
      totals: { subtotal: totals.subtotal, shipping: totals.shipping, grandTotal: totals.grandTotal },
    });
  } catch (err) {
    console.error('submit error', err.message);
    return res.status(500).json({ error: 'אירעה שגיאה ביצירת ההזמנה. נסו שוב.' });
  }
});

/* =========================================================================
 * 5b) CATALOG STORE ORDERS — orders coming from the rich index.html catalog.
 *     Prices are recomputed server-side from the product id (never trust client).
 * ========================================================================= */
// Maps a rich (index.html) product id to one of the catalog product-type ids,
// so a price edited in the admin instantly drives the site AND order pricing.
function catalogIdFor(id) {
  id = String(id || '');
  const youth = id.indexOf('y-') === 0;
  if (id.indexOf('-suit-') >= 0)           return youth ? 'suit-youth' : 'suit-kids';
  if (id.indexOf('-shirt-linen') >= 0)     return 'linen-shirt-kids';
  if (id.indexOf('-shirt-classic') >= 0)   return 'shirt-regular';
  if (id.indexOf('-pants-linen') >= 0)     return youth ? 'linen-pants-youth' : 'linen-pants-kids';
  if (id.indexOf('-pants-parade') >= 0)    return youth ? 'parade-pants-youth' : 'parade-pants-kids';
  if (id.indexOf('-pants-oversized') >= 0) return youth ? 'oversized-pants-youth' : 'oversized-pants-kids';
  if (id.indexOf('-vest-') >= 0)           return 'vest';
  if (id.indexOf('-shoes-') >= 0)          return 'shoes';
  if (id.indexOf('-belt') >= 0)            return 'belt';
  if (id.indexOf('-bowtie') >= 0)          return 'bowtie';
  return null;
}
function priceForId(id) {
  const cid = catalogIdFor(id);
  if (!cid) return null;
  const p = productById.get(cid);
  return p ? p.price : null;
}
// Price map (catalog id → price) for the storefront to display admin-edited prices.
function priceMap() {
  const m = {};
  CATALOG.forEach((p) => { m[p.id] = p.price; });
  return m;
}

app.post('/api/store/submit', (req, res) => {
  try {
    const method = req.body && req.body.shippingMethod;
    if (!isValidMethod(method)) return res.status(400).json({ error: 'יש לבחור שיטת משלוח' });

    const { ok, errors, customer } = validateCustomer(req.body);
    if (!ok) return res.status(422).json({ error: 'טופס לא תקין', fields: errors });

    const raw = req.body && req.body.items;
    if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: 'העגלה ריקה' });

    const items = [];
    for (const it of raw) {
      const price = priceForId(it.productId);
      if (price == null) return res.status(400).json({ error: `מוצר לא קיים: ${it.name || it.productId}` });
      const quantity = Math.max(1, parseInt(it.quantity, 10) || 1);
      items.push({
        productId: String(it.productId),
        name: String(it.name || it.productId),
        color: String(it.color || ''),
        size: String(it.size || ''),
        quantity,
        price,
      });
    }

    const totals = computeTotals(method, items);
    const pay = paymentFor(method);
    const order = orderRepository.create({
      status: pay.status,
      paymentMethod: pay.paymentMethod,
      paymentLabel: pay.label,
      shippingMethod: method,
      source: 'catalog',
      customer,
      items,
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      grandTotal: totals.grandTotal,
      createdAt: new Date().toISOString(),
    });
    notifyOrder(order);

    return res.status(201).json({
      ok: true,
      orderId: order.id,
      status: order.status,
      paymentLabel: order.paymentLabel,
      totals: { subtotal: totals.subtotal, shipping: totals.shipping, grandTotal: totals.grandTotal },
    });
  } catch (err) {
    console.error('store submit error', err.message);
    return res.status(500).json({ error: 'אירעה שגיאה ביצירת ההזמנה. נסו שוב.' });
  }
});

/* =========================================================================
 * 6) ADMIN  (orders board + catalog/inventory editor)
 *    Optional auth: set ADMIN_TOKEN in env to require an "x-admin-token" header.
 *    For production, replace this with REAL authentication.
 * ========================================================================= */
const ORDER_STATUSES = ['pending_cash', 'pending_pickup_cash', 'completed', 'cancelled'];
const STOCK_STATUSES = ['in_stock', 'out_of_stock'];

function adminAuth(req, res, next) {
  const required = process.env.ADMIN_TOKEN;
  if (required && req.get('x-admin-token') !== required) {
    return res.status(401).json({ error: 'גישה נדחתה' });
  }
  next();
}

app.get('/api/admin/orders', adminAuth, (_req, res) => {
  res.json({ orders: orders.slice().reverse() });
});

// Store settings — read & update (shipping rules, contact, banner).
app.get('/api/admin/settings', adminAuth, (_req, res) => res.json({ settings: SETTINGS }));
app.post('/api/admin/settings', adminAuth, (req, res) => {
  const b = req.body || {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  if (b.freeThreshold !== undefined) SETTINGS.freeThreshold = num(b.freeThreshold, SETTINGS.freeThreshold);
  if (b.flatFee !== undefined) SETTINGS.flatFee = num(b.flatFee, SETTINGS.flatFee);
  ['studioAddress', 'ownerPhone', 'whatsapp', 'smsSender', 'bannerHe', 'bannerEn', 'bannerFr'].forEach((k) => {
    if (typeof b[k] === 'string' && b[k].trim()) SETTINGS[k] = b[k].trim();
  });
  res.json({ ok: true, settings: SETTINGS });
});

app.post('/api/admin/orders/:id/status', adminAuth, (req, res) => {
  const order = orderRepository.getById(req.params.id);
  if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  const status = req.body && req.body.status;
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'סטטוס לא תקין' });
  order.status = status;
  order.updatedAt = new Date().toISOString();
  res.json({ ok: true, order });
});

app.post('/api/admin/products/:id', adminAuth, (req, res) => {
  const product = productById.get(String(req.params.id));
  if (!product) return res.status(404).json({ error: 'מוצר לא קיים' });
  const { price, stockStatus } = req.body || {};
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'מחיר לא תקין' });
    product.price = round2(p);
  }
  if (stockStatus !== undefined) {
    if (!STOCK_STATUSES.includes(stockStatus)) return res.status(400).json({ error: 'סטטוס מלאי לא תקין' });
    product.stockStatus = stockStatus;
  }
  res.json({ ok: true, product });
});

/* =========================================================================
 * 7) SERVE THE FRONTEND
 * ========================================================================= */
/* =========================================================================
 * 6b) IMAGES — admin uploads/deletes product & cover images; site reads overrides.
 * ========================================================================= */
const IMG_DATA_FILE = path.join(__dirname, 'data-images.json');
let imgState = { variants: {}, covers: {} };    // persisted overrides
let imgCatalog = { variants: [], covers: [] };  // snapshot published by the storefront (for the admin UI)
try { if (fs.existsSync(IMG_DATA_FILE)) imgState = JSON.parse(fs.readFileSync(IMG_DATA_FILE, 'utf8')); } catch (e) { console.warn('img load', e.message); }
function saveImgState() { try { fs.writeFileSync(IMG_DATA_FILE, JSON.stringify(imgState, null, 2)); } catch (e) { console.warn('img save', e.message); } }

const PHOTOS_DIR = path.join(__dirname, 'photos');
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function saveDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png';
  const name = 'up-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + ext;
  try { fs.writeFileSync(path.join(PHOTOS_DIR, name), Buffer.from(m[2], 'base64')); return 'photos/' + name; }
  catch (e) { console.warn('write img', e.message); return null; }
}

app.post('/api/_imgcatalog', (req, res) => {           // storefront publishes its catalog for the admin
  const b = req.body || {};
  if (Array.isArray(b.variants)) imgCatalog.variants = b.variants;
  if (Array.isArray(b.covers)) imgCatalog.covers = b.covers;
  res.json({ ok: true });
});
app.get('/api/images', (_req, res) => res.json(imgState)); // site reads overrides
app.get('/api/admin/imagecatalog', adminAuth, (_req, res) => {
  const variants = imgCatalog.variants.map((v) => Object.assign({}, v, { images: imgState.variants[v.key] || v.images || [] }));
  const covers = imgCatalog.covers.map((c) => Object.assign({}, c, { url: imgState.covers[c.catSub] || c.url || '' }));
  res.json({ variants, covers });
});
app.post('/api/admin/image/upload', adminAuth, (req, res) => {
  const url = saveDataUrl(req.body && req.body.dataUrl);
  if (!url) return res.status(400).json({ error: 'קובץ לא תקין' });
  res.json({ ok: true, url });
});
app.post('/api/admin/image/setVariant', adminAuth, (req, res) => {
  const key = String((req.body && req.body.key) || '');
  const urls = (req.body && req.body.urls) || [];
  if (!key) return res.status(400).json({ error: 'מפתח חסר' });
  if (Array.isArray(urls) && urls.length) imgState.variants[key] = urls.map(String);
  else delete imgState.variants[key];
  saveImgState();
  res.json({ ok: true, urls: imgState.variants[key] || [] });
});
app.post('/api/admin/cover/set', adminAuth, (req, res) => {
  const catSub = String((req.body && req.body.catSub) || '');
  const url = String((req.body && req.body.url) || '');
  if (!catSub) return res.status(400).json({ error: 'מחלקה חסרה' });
  if (url) imgState.covers[catSub] = url; else delete imgState.covers[catSub];
  saveImgState();
  res.json({ ok: true, url: imgState.covers[catSub] || '' });
});

// Public order lookup (used by the customer SMS link).
app.get('/api/order/:id', (req, res) => {
  const o = orderRepository.getById(req.params.id);
  if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
  res.json({ order: o });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));        // beautiful catalog
app.get('/checkout', (_req, res) => res.sendFile(path.join(__dirname, 'checkout.html'))); // simple checkout
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/order', (_req, res) => res.sendFile(path.join(__dirname, 'order.html')));    // order detail (SMS link)
// static assets (photos, rf-store.js, css, etc.) — must come after the explicit page routes
app.use(express.static(__dirname, { index: false }));

app.listen(PORT, () => console.log(`Refael Fashion server → http://localhost:${PORT}  (admin: /admin)`));
