'use strict';
/*
 * Cosmic Vibez Creations: zero-dependency server (Node 18+, global fetch).
 * Serves public/, takes quote requests (with file uploads) onto a persistent
 * disk, emails through Resend, runs a password-protected admin API, and
 * creates Stripe payment links.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, 'public');
const PHONE_DISPLAY = '908-248-2374';
const PHONE_DIGITS = '19082482374';

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
function C() {
  const domain = String(env('SITE_DOMAIN', 'cosmicvibezcreations.com')).toLowerCase();
  return {
    domain,
    siteUrl: String(env('SITE_URL', 'https://' + domain)).replace(/\/+$/, ''),
    alertTo: env('ALERT_TO', 'Cosmicvibezcreations@gmail.com'),
    mailFrom: env('MAIL_FROM', 'Cosmic Vibez Creations <quotes@' + domain + '>'),
  };
}

const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'data'));
const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

const STATUSES = ['new', 'in_progress', 'quoted', 'awaiting_payment', 'paid', 'completed', 'cancelled'];
const NEEDS = ['Laser Engraving', '3D Printing'];
const AUDIENCES = ['Me / A Gift', 'A Business'];
const HEARD = ['Instagram', 'Facebook', 'Google', 'A friend', 'Other'];
const EXT_OK = /\.(png|jpe?g|gif|webp|heic|pdf|stl|obj|3mf)$/i;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 6;
const HOUR = 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

/* ---------- small helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function safeEq(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
const clean1 = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const cleanN = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
function phoneDigits(p) { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '1' + d; return d.length >= 7 && d.length <= 15 ? d : ''; }
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } };
const money = (cents) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* rate limits kept in memory */
const hits = new Map();
function count(key, windowMs) { const now = Date.now(); const a = (hits.get(key) || []).filter((t) => now - t < windowMs); hits.set(key, a); return a.length; }
function record(key) { const a = hits.get(key) || []; a.push(Date.now()); hits.set(key, a); }
function allow(key, limit, windowMs) { if (count(key, windowMs) >= limit) return false; record(key); return true; }

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > max) { req.resume(); return reject(httpErr(413, 'That is too large.')); }
    let size = 0, finished = false; const chunks = [];
    req.on('data', (c) => {
      if (finished) return;
      size += c.length;
      if (size > max) { finished = true; chunks.length = 0; reject(httpErr(413, 'That is too large.')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!finished) { finished = true; reject(e); } });
  });
}
async function readJson(req, max) {
  const raw = await readBody(req, max);
  try { const o = JSON.parse(raw.toString('utf8')); if (o && typeof o === 'object') return o; } catch (e) { /* fall through */ }
  throw httpErr(400, 'Invalid request.');
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function text(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------- storage (persistent disk) ---------- */
let quotes = [];
const notifying = new Set();
function loadQuotes() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  try { quotes = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; quotes = []; }
}
function saveQuotes() {
  const tmp = QUOTES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(quotes));
  fs.renameSync(tmp, QUOTES_FILE);
}
const findQuote = (id) => quotes.find((q) => q.id === id);
function view(q) {
  const o = Object.assign({}, q);
  delete o.token; delete o.alertTries;
  o.files = q.files.map((f) => ({ id: f.id, name: f.name, size: f.size }));
  o.incomplete = !q.done;
  return o;
}
loadQuotes();

/* ---------- email (Resend) ---------- */
async function sendMail({ to, subject, html, text: plain, replyTo }) {
  const key = env('RESEND_API_KEY');
  if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' };
  const c = C();
  const attempt = (from) => {
    const list = (x) => String(x || '').split(/[,;\s]+/).filter(Boolean);
    const body = { from, to: list(to), subject, html, text: plain };
    if (replyTo) body.reply_to = list(replyTo);
    return fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
  };
  try {
    let r = await attempt(c.mailFrom);
    if ((r.status === 403 || r.status === 422) && !/onboarding@resend\.dev/.test(c.mailFrom)) {
      r = await attempt('Cosmic Vibez Creations <onboarding@resend.dev>');
    }
    if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, error: 'Resend ' + r.status + ' ' + t.slice(0, 200) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

const btn = (href, label, bg, fg) => '<a href="' + esc(href) + '" style="display:inline-block;margin:4px 6px 4px 0;padding:11px 20px;border-radius:999px;background:' + bg + ';color:' + (fg || '#ffffff') + ';font:600 14px Arial,sans-serif;text-decoration:none">' + esc(label) + '</a>';
const row = (l, v) => '<tr><td style="padding:6px 14px 6px 0;color:#666;vertical-align:top;white-space:nowrap">' + esc(l) + '</td><td style="padding:6px 0;color:#111">' + v + '</td></tr>';

function alertMail(q, incomplete) {
  const c = C();
  const digits = phoneDigits(q.phone);
  const first = q.name.split(/\s+/)[0];
  const textUrl = c.siteUrl + '/text?to=' + digits + '&name=' + encodeURIComponent(first);
  const mailto = 'mailto:' + q.email + '?subject=' + encodeURIComponent('Your Cosmic Vibez Creations quote (#' + q.num + ')') +
    '&body=' + encodeURIComponent('Hi ' + first + ',\n\nThanks for reaching out to Cosmic Vibez Creations about ' + q.need.join(' and ') + '. Request received ' + fmtTime(q.created) + '.\n\n');
  const attached = q.files.length ? q.files.map((f) => esc(f.name) + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)').join('<br>') : 'None';
  let warn = '';
  if (incomplete) warn = '<p style="background:#fff3cd;border:1px solid #e0b800;padding:10px 12px;border-radius:8px;color:#5b4700">This request was never finalized (the customer\'s upload may have been interrupted). ' + q.files.length + ' of ' + q.expected_files + ' files arrived.</p>';
  else if (q.expected_files > q.files.length) warn = '<p style="background:#fff3cd;border:1px solid #e0b800;padding:10px 12px;border-radius:8px;color:#5b4700">The customer tried to attach ' + q.expected_files + ' files, but only ' + q.files.length + ' arrived. Ask them to email the rest.</p>';
  const rows = [
    row('Name', esc(q.name)),
    row('Phone', digits ? '<a href="tel:+' + digits + '">' + esc(q.phone) + '</a> &nbsp;<a href="' + esc(textUrl) + '">Text</a>' : esc(q.phone || 'Not given')),
    row('Email', '<a href="mailto:' + esc(q.email) + '">' + esc(q.email) + '</a>'),
    row('Needs', esc(q.need.join(', '))),
    row('For', esc(q.audience || 'Not given')),
    row('Quantity', esc(q.quantity || 'Not given')),
    row('Needed by', esc(q.needed_by || 'Not given')),
    row('Item or material', esc(q.item || 'Not given')),
    row('Details', '<div style="white-space:pre-wrap">' + esc(q.message) + '</div>'),
    row('Files', attached),
    row('Heard about us', esc(q.heard || 'Not given')),
    row('Received', esc(fmtTime(q.created))),
  ].join('');
  const buttons = (digits ? btn(textUrl, 'Text', '#7c5cff') : '') + btn(mailto, 'Email', '#0f9fa3') + (digits ? btn('tel:+' + digits, 'Call', '#d6336c') : '') + btn(c.siteUrl + '/admin', 'Open Admin', '#222222');
  const html = '<div style="font:15px/1.5 Arial,sans-serif;max-width:620px"><h2 style="margin:0 0 4px">New quote request #' + q.num + '</h2>' + warn + '<table style="border-collapse:collapse;margin:10px 0 14px">' + rows + '</table><div>' + buttons + '</div><p style="color:#888;font-size:12px">Reply to this email to answer ' + esc(first) + ' directly. Files are in the admin page.</p></div>';
  const plain = 'New quote request #' + q.num + '\nName: ' + q.name + '\nPhone: ' + (q.phone || '-') + '\nEmail: ' + q.email + '\nNeeds: ' + q.need.join(', ') + '\nFor: ' + (q.audience || '-') + '\nQuantity: ' + (q.quantity || '-') + '\nNeeded by: ' + (q.needed_by || '-') + '\nItem: ' + (q.item || '-') + '\n\n' + q.message + '\n\nFiles: ' + q.files.length + '\nAdmin: ' + c.siteUrl + '/admin';
  return { to: c.alertTo, subject: 'New quote request #' + q.num + ': ' + q.name + (incomplete ? ' (upload incomplete)' : ''), html, text: plain, replyTo: q.email };
}

function confirmMail(q) {
  const c = C();
  const first = esc(q.name.split(/\s+/)[0]);
  const html = '<div style="font:15px/1.6 Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 8px">We got your quote request, ' + first + '.</h2>' +
    '<p>You asked about <strong>' + esc(q.need.join(' and ')) + '</strong>' + (q.item ? ' (' + esc(q.item) + ')' : '') + '. We will review it and reply with your free, no-obligation quote.</p>' +
    '<p>Nothing is made until you approve a proof and payment is received. Details are on our <a href="' + esc(c.siteUrl) + '/policies">Store Policies</a> page.</p>' +
    '<p>Questions? Text or call ' + PHONE_DISPLAY + ', or just reply to this email.</p><p style="color:#888;font-size:12px">Cosmic Vibez Creations, Keyport, NJ 07735</p></div>';
  const plain = 'We got your quote request. We will review it and reply with your free, no-obligation quote. Nothing is made until you approve a proof and payment is received. Questions? Text or call ' + PHONE_DISPLAY + '.';
  return { to: q.email, subject: 'We got your quote request (#' + q.num + ')', html, text: plain, replyTo: c.alertTo };
}

async function notify(q, incomplete) {
  if (notifying.has(q.id)) return;
  notifying.add(q.id);
  try {
    if (!q.alerted) {
      q.alertTries = (q.alertTries || 0) + 1;
      const r = await sendMail(alertMail(q, incomplete));
      if (r.ok) q.alerted = true; else console.error('alert email failed for quote', q.num, r.error);
    }
    if (q.done && !q.confirmed) {
      q.confirmed = true; // best effort, tried once
      const r = await sendMail(confirmMail(q));
      if (!r.ok) console.error('confirmation email failed for quote', q.num, r.error);
    }
    saveQuotes();
  } finally { notifying.delete(q.id); }
}

async function sweep() {
  const now = Date.now();
  for (const q of quotes.slice()) {
    if (q.alerted || (q.alertTries || 0) >= 12) continue;
    const stale = !q.done && now - Date.parse(q.created) > 20 * 60 * 1000;
    if (stale || q.done) await notify(q, !q.done);
  }
}

/* ---------- Stripe ---------- */
async function stripePost(p, params) {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) throw httpErr(503, 'Stripe is not connected yet. Add STRIPE_SECRET_KEY on the server.');
  const r = await fetch('https://api.stripe.com/v1/' + p, {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw httpErr(502, 'Stripe: ' + ((j.error && j.error.message) || r.status));
  return j;
}
function verifyStripe(raw, header, secret) {
  if (!header) return false;
  const parts = String(header).split(',').map((s) => s.trim().split('='));
  const t = (parts.find((x) => x[0] === 't') || [])[1];
  const sigs = parts.filter((x) => x[0] === 'v1').map((x) => x[1]);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const exp = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(t + '.'), raw])).digest('hex');
  return sigs.some((s) => safeEq(s, exp));
}
function markPaid(s) {
  const qid = s.metadata && s.metadata.quote_id;
  const q = quotes.find((x) => x.id === qid) || quotes.find((x) => x.payments.some((pm) => pm.id === s.payment_link));
  if (!q) return;
  const pay = q.payments.find((pm) => pm.id === s.payment_link) || q.payments.find((pm) => !pm.paid_at && pm.amount_cents === s.amount_total);
  if (!pay || pay.paid_at) return;
  pay.paid_at = nowIso(); pay.session = s.id;
  if (q.status !== 'completed' && q.status !== 'cancelled') q.status = q.payments.every((x) => x.paid_at) ? 'paid' : 'in_progress';
  q.updated = nowIso(); saveQuotes();
  const c = C();
  sendMail({
    to: c.alertTo, subject: 'Payment received: ' + money(pay.amount_cents) + ' for quote #' + q.num + ' (' + q.name + ')',
    html: '<div style="font:15px Arial,sans-serif"><h2>Payment received</h2><p>' + esc(q.name) + ' paid <strong>' + money(pay.amount_cents) + '</strong> (' + esc(pay.label) + ') on quote #' + q.num + '.</p>' + btn(c.siteUrl + '/admin', 'Open Admin', '#222222') + '</div>',
    text: q.name + ' paid ' + money(pay.amount_cents) + ' on quote #' + q.num + '.',
  }).catch(() => {});
}

/* ---------- admin auth ---------- */
const adminPw = () => String(env('ADMIN_PASSWORD', '')).trim();
const adminReady = () => adminPw().length >= 10;
const adminKey = () => sha('cosmic-admin-v1:' + adminPw());
function makeSession() {
  const exp = String(Date.now() + 12 * HOUR);
  return exp + '.' + crypto.createHmac('sha256', adminKey()).update(exp).digest('base64url');
}
function validSession(req) {
  if (!adminReady()) return false;
  const m = /(?:^|;\s*)cv_admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEq(sig, crypto.createHmac('sha256', adminKey()).update(exp).digest('base64url'));
}
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

/* ---------- API handlers ---------- */
async function postQuote(req, res) {
  const b = await readJson(req, 20 * 1024);
  if (b.website) return json(res, 200, { ok: true, id: '0', token: '0' }); // honeypot: pretend it worked
  const name = clean1(b.name, 100);
  const email = clean1(b.email, 150).toLowerCase();
  const phone = clean1(b.phone, 40);
  const need = (Array.isArray(b.need) ? b.need : []).filter((n) => NEEDS.includes(n)).filter((n, i, a) => a.indexOf(n) === i);
  const audience = AUDIENCES.includes(b.audience) ? b.audience : '';
  const heard = HEARD.includes(b.heard) ? b.heard : '';
  const item = clean1(b.item, 150);
  const message = cleanN(b.message, 4000);
  const quantity = b.quantity === '' || b.quantity == null ? '' : String(b.quantity).trim();
  const needed_by = clean1(b.needed_by, 10);
  const fileCount = Number(b.file_count || 0);
  if (!name) throw httpErr(400, 'Please add your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpErr(400, 'Please enter a valid email.');
  if (phone && phoneDigits(phone) === '') throw httpErr(400, 'That phone number does not look right.');
  if (!need.length) throw httpErr(400, 'Pick Laser Engraving, 3D Printing or both.');
  if (!message) throw httpErr(400, 'Tell us a little about what you want.');
  if (quantity && !/^\d{1,6}$/.test(quantity)) throw httpErr(400, 'Quantity should be a whole number.');
  if (needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(needed_by)) throw httpErr(400, 'That date does not look right.');
  if (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > MAX_FILES) throw httpErr(400, 'Up to ' + MAX_FILES + ' files per request.');
  const ip = getIp(req);
  if (!allow('q-ip:' + ip, 8, HOUR) || !allow('q-em:' + email, 4, HOUR)) throw httpErr(429, 'Too many requests. Please text ' + PHONE_DISPLAY + '.');
  let id; do { id = crypto.randomBytes(5).toString('hex'); } while (findQuote(id));
  const iso = nowIso();
  const q = {
    id, token: crypto.randomBytes(16).toString('hex'), num: quotes.reduce((m, x) => Math.max(m, x.num || 0), 0) + 1,
    created: iso, updated: iso, status: 'new', done: false, alerted: false, alertTries: 0, confirmed: false, expected_files: fileCount,
    name, phone, email, need, audience, quantity, needed_by, item, message, heard, files: [], notes: '', quoted_amount: null, payments: [],
  };
  quotes.push(q); saveQuotes();
  json(res, 200, { ok: true, id: q.id, token: q.token });
}

function authedQuote(id, query) {
  const q = findQuote(id);
  if (!q) throw httpErr(404, 'Not found.');
  if (!safeEq(query.get('token') || '', q.token)) throw httpErr(403, 'Not allowed.');
  return q;
}
async function postFile(req, res, id, query) {
  if (id === '0') { req.resume(); return json(res, 200, { ok: true }); }
  const q = authedQuote(id, query);
  if (q.done) throw httpErr(409, 'This request was already sent.');
  if (q.files.length >= MAX_FILES) throw httpErr(400, 'Up to ' + MAX_FILES + ' files per request.');
  const name = String(query.get('name') || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(-100) || 'file';
  if (!EXT_OK.test(name)) throw httpErr(400, 'That file type is not supported.');
  const body = await readBody(req, MAX_FILE);
  if (!body.length) throw httpErr(400, 'That file is empty.');
  const fid = crypto.randomBytes(6).toString('hex');
  const stored = fid + path.extname(name).toLowerCase();
  const dir = path.join(FILES_DIR, q.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), body);
  q.files.push({ id: fid, name, size: body.length, stored });
  q.updated = nowIso(); saveQuotes();
  json(res, 200, { ok: true });
}
async function postDone(req, res, id, query) {
  if (id === '0') return json(res, 200, { ok: true });
  const q = authedQuote(id, query);
  if (!q.done) { q.done = true; q.updated = nowIso(); saveQuotes(); }
  await notify(q, false);
  json(res, 200, { ok: true });
}

async function createPayLink(req, res, q) {
  const b = await readJson(req, 4096);
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount < 0.5 || amount > 50000) throw httpErr(400, 'Enter an amount between $0.50 and $50,000.');
  const cents = Math.round(amount * 100);
  if (Math.abs(cents / 100 - amount) > 1e-9) throw httpErr(400, 'Use at most 2 decimal places.');
  const label = clean1(b.label, 60) || 'Payment';
  const c = C();
  const price = await stripePost('prices', { currency: 'usd', unit_amount: String(cents), 'product_data[name]': 'Cosmic Vibez Creations: ' + label + ' (Quote #' + q.num + ')' });
  const pl = await stripePost('payment_links', {
    'line_items[0][price]': price.id, 'line_items[0][quantity]': '1',
    'metadata[quote_id]': q.id, 'metadata[quote_num]': String(q.num),
    'after_completion[type]': 'redirect', 'after_completion[redirect][url]': c.siteUrl + '/paid.html',
  });
  if (!/^https:\/\//.test(String(pl.url || ''))) throw httpErr(502, 'Stripe did not return a link.');
  const url = pl.url + (pl.url.includes('?') ? '&' : '?') + 'prefilled_email=' + encodeURIComponent(q.email);
  const pay = { id: pl.id, url, amount_cents: cents, label, created: nowIso(), paid_at: null };
  q.payments.push(pay);
  if (['new', 'in_progress', 'quoted'].includes(q.status)) q.status = 'awaiting_payment';
  q.updated = nowIso(); saveQuotes();
  let emailed = false;
  if (b.email_customer) {
    const first = esc(q.name.split(/\s+/)[0]);
    const r = await sendMail({
      to: q.email, replyTo: c.alertTo, subject: 'Your Cosmic Vibez Creations payment link (quote #' + q.num + ')',
      html: '<div style="font:15px/1.6 Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 8px">Hi ' + first + ', your payment link is ready.</h2><p>' + esc(label) + ': <strong>' + money(cents) + '</strong></p><p>' + btn(url, 'Pay ' + money(cents), '#7c5cff') + '</p><p>By paying you agree to our <a href="' + esc(c.siteUrl) + '/policies">Store Policies</a>. Questions? Text or call ' + PHONE_DISPLAY + ', or reply to this email.</p></div>',
      text: 'Your payment link (' + label + ', ' + money(cents) + '): ' + url + '\nQuestions? Text or call ' + PHONE_DISPLAY + '.',
    });
    emailed = r.ok;
  }
  json(res, 200, { ok: true, payment: pay, emailed });
}

async function webhook(req, res) {
  const secret = env('STRIPE_WEBHOOK_SECRET');
  if (!secret) throw httpErr(503, 'Webhook is not configured.');
  const raw = await readBody(req, 1024 * 1024);
  if (!verifyStripe(raw, req.headers['stripe-signature'], secret)) throw httpErr(400, 'Bad signature.');
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { throw httpErr(400, 'Bad payload.'); }
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    const s = (ev.data && ev.data.object) || {};
    if (s.payment_status === 'paid') markPaid(s);
  }
  json(res, 200, { received: true });
}

async function adminApi(req, res, p, query) {
  const m = req.method;
  if (m === 'POST' && p === '/api/admin/login') {
    if (!adminReady()) throw httpErr(503, 'Admin login is not set up yet. Set ADMIN_PASSWORD (10+ characters) on the server.');
    const ip = getIp(req);
    if (count('login-ip:' + ip, 15 * 60 * 1000) >= 5 || count('login-all', 15 * 60 * 1000) >= 20) throw httpErr(429, 'Too many attempts. Try again in 15 minutes.');
    const b = await readJson(req, 2048);
    if (typeof b.password !== 'string' || !safeEq(b.password.trim(), adminPw())) {
      record('login-ip:' + ip); record('login-all');
      throw httpErr(401, 'Wrong password.');
    }
    res.setHeader('Set-Cookie', 'cv_admin=' + makeSession() + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + (isHttps(req) ? '; Secure' : ''));
    return json(res, 200, { ok: true });
  }
  if (!validSession(req)) throw httpErr(401, 'Not signed in.');
  if (m !== 'GET' && req.headers['x-admin'] !== '1') throw httpErr(403, 'Forbidden.');
  if (m === 'POST' && p === '/api/admin/logout') {
    res.setHeader('Set-Cookie', 'cv_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/admin/quotes') {
    return json(res, 200, { quotes: quotes.slice().sort((a, b) => b.num - a.num).map(view), stripe: !!env('STRIPE_SECRET_KEY') });
  }
  if (m === 'POST' && p === '/api/admin/delete-finished') {
    const gone = quotes.filter((q) => q.status === 'completed' || q.status === 'cancelled');
    gone.forEach((q) => fs.rmSync(path.join(FILES_DIR, q.id), { recursive: true, force: true }));
    quotes = quotes.filter((q) => !gone.includes(q)); saveQuotes();
    return json(res, 200, { ok: true, deleted: gone.length });
  }
  let mm = /^\/api\/admin\/quotes\/([a-f0-9]{10})(?:\/(files\/([a-f0-9]{12})|payment-link))?$/.exec(p);
  if (!mm) throw httpErr(404, 'Not found.');
  const q = findQuote(mm[1]);
  if (!q) throw httpErr(404, 'Not found.');
  if (m === 'GET' && mm[3]) {
    const f = q.files.find((x) => x.id === mm[3]);
    if (!f) throw httpErr(404, 'Not found.');
    const abs = path.join(FILES_DIR, q.id, f.stored);
    if (!fs.existsSync(abs)) throw httpErr(404, 'File is missing on disk.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f.stored).toLowerCase()] || 'application/octet-stream', 'Content-Length': f.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(f.name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    });
    return fs.createReadStream(abs).pipe(res);
  }
  if (m === 'POST' && mm[2] === 'payment-link') return createPayLink(req, res, q);
  if (m === 'PATCH' && !mm[2]) {
    const b = await readJson(req, 8192);
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw httpErr(400, 'Unknown status.'); q.status = b.status; }
    if (b.notes !== undefined) { if (typeof b.notes !== 'string' || b.notes.length > 4000) throw httpErr(400, 'Notes are too long.'); q.notes = cleanN(b.notes, 4000); }
    if (b.quoted_amount !== undefined) {
      if (b.quoted_amount === null || b.quoted_amount === '') q.quoted_amount = null;
      else { const n = Number(b.quoted_amount); if (!isFinite(n) || n < 0 || n > 1000000) throw httpErr(400, 'That amount does not look right.'); q.quoted_amount = Math.round(n * 100) / 100; }
    }
    q.updated = nowIso(); saveQuotes();
    return json(res, 200, { ok: true, quote: view(q) });
  }
  if (m === 'DELETE' && !mm[2]) {
    fs.rmSync(path.join(FILES_DIR, q.id), { recursive: true, force: true });
    quotes = quotes.filter((x) => x !== q); saveQuotes();
    return json(res, 200, { ok: true });
  }
  throw httpErr(405, 'Method not allowed.');
}

async function api(req, res, p, query) {
  const m = req.method;
  if (p.startsWith('/api/admin/')) return adminApi(req, res, p, query);
  if (m === 'POST' && p === '/api/quote') return postQuote(req, res);
  let mm = /^\/api\/quote\/([a-f0-9]{10}|0)\/(files|done)$/.exec(p);
  if (m === 'POST' && mm) return mm[2] === 'files' ? postFile(req, res, mm[1], query) : postDone(req, res, mm[1], query);
  if (m === 'POST' && p === '/api/stripe/webhook') return webhook(req, res);
  throw httpErr(404, 'Not found.');
}

/* ---------- pages ---------- */
function textPage(res, query) {
  const to = query.get('to') || '';
  if (!/^\d{7,15}$/.test(to)) return text(res, 400, 'Bad request');
  const name = (query.get('name') || '').replace(/[^\p{L}\p{N} '\-]/gu, '').slice(0, 40);
  const body = 'Hi' + (name ? ' ' + name : '') + ", it's Cosmic Vibez Creations about your quote request.";
  const sms = 'sms:+' + to + '?&body=' + encodeURIComponent(body);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark only"><title>Open Messages</title>' +
    '<style>html,body{background:#0a0919;color:#ece9ff;font:16px/1.6 system-ui,sans-serif;margin:0}main{max-width:420px;margin:0 auto;padding:60px 20px;text-align:center}a.b{display:block;margin:14px 0;padding:15px;border-radius:999px;background:linear-gradient(90deg,#35e4e8,#7c5cff 60%,#ff5fa2);color:#0a0919;font-weight:700;text-decoration:none}a.g{background:none;border:1.5px solid #2c2762;color:#ece9ff}</style></head><body><main><h1>Opening Messages</h1><p>If nothing happens, tap the button.</p>' +
    '<a class="b" href="' + esc(sms) + '">Open Messages</a><a class="b g" href="tel:+' + to + '">Call instead</a></main><script>setTimeout(function(){location.href=' + JSON.stringify(sms) + '},150)</script></body></html>';
  text(res, 200, html, 'text/html; charset=utf-8');
}

function serveStatic(req, res, pathRaw) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
  let p;
  try { p = decodeURIComponent(pathRaw); } catch (e) { return text(res, 400, 'Bad request'); }
  if (p.includes('\0')) return text(res, 400, 'Bad request');
  const map = { '/': '/index.html', '/policies': '/policies.html', '/shop': '/shop.html', '/studio': '/studio.html', '/customize': '/studio.html', '/admin': '/admin.html', '/admin/': '/admin.html' };
  p = map[p] || p;
  if (p.split('/').some((seg) => seg.startsWith('.'))) return text(res, 404, 'Not found');
  const abs = path.resolve(PUBLIC, '.' + p);
  if (abs !== PUBLIC && !abs.startsWith(PUBLIC + path.sep)) return text(res, 404, 'Not found');
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return text(res, 404, 'Not found');
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  const c = C();
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (host === 'www.' + c.domain) {
    res.writeHead(301, { Location: c.siteUrl + (req.url.startsWith('/') ? req.url : '/') });
    return res.end();
  }
  const qi = req.url.indexOf('?');
  const pathRaw = qi < 0 ? req.url : req.url.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? '' : req.url.slice(qi + 1));
  if (pathRaw === '/healthz') return text(res, 200, 'ok');
  if (pathRaw.startsWith('/api/')) return api(req, res, pathRaw, query);
  if (pathRaw === '/text' && req.method === 'GET') return textPage(res, query);
  if (pathRaw === '/robots.txt') return text(res, 200, 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ' + c.siteUrl + '/sitemap.xml\n');
  if (pathRaw === '/sitemap.xml') {
    return text(res, 200, '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>' + c.siteUrl + '/</loc></url>\n<url><loc>' + c.siteUrl + '/shop</loc></url>\n<url><loc>' + c.siteUrl + '/studio</loc></url>\n<url><loc>' + c.siteUrl + '/policies</loc></url>\n</urlset>\n', 'application/xml; charset=utf-8');
  }
  return serveStatic(req, res, pathRaw);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) { res.destroy(); return; }
    if (err && err.status) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'Something went wrong. Please text ' + PHONE_DISPLAY + '.' });
  });
});

function start(port) {
  setInterval(() => { sweep().catch((e) => console.error('sweep failed', e)); }, 5 * 60 * 1000).unref();
  setInterval(() => { for (const k of hits.keys()) if (count(k, HOUR) === 0) hits.delete(k); }, HOUR).unref();
  return server.listen(port, '0.0.0.0', () => console.log('Cosmic Vibez server on ' + port + ', data in ' + DATA_DIR));
}

module.exports = { server, start, sweep, quotes: () => quotes };

if (require.main === module) {
  if (env('RENDER') === 'true' && !process.env.DATA_DIR) {
    console.error('DATA_DIR is not set. Quotes and uploads would be lost on every deploy. Attach a Render disk and set DATA_DIR to its mount path (for example /var/data).');
    process.exit(1);
  }
  start(parseInt(env('PORT', '3000'), 10));
}
