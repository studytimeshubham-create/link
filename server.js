// Gateway: the only thing clients talk to (so China never needs to reach Firebase).
// It stores and relays CIPHERTEXT only; it never sees message content.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.JWT_SECRET || (PROD ? null : crypto.randomBytes(32).toString('hex'));
if (!SECRET) throw new Error('Set JWT_SECRET in production');

// ---------- Storage: Firestore if credentials exist, else in-memory (dev) ----------
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: process.env.FIREBASE_SERVICE_ACCOUNT
      ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      : admin.credential.applicationDefault(),
  });
  db = admin.firestore();
  console.log('Storage: Firestore');
} else if (PROD) {
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT in production');
} else console.log('Storage: in-memory (dev only, data is lost on restart)');

const mem = { users: new Map(), msgs: [] };
const store = {
  async getUser(phone) {
    if (db) { const d = await db.collection('users').doc(phone).get(); return d.exists ? d.data() : null; }
    return mem.users.get(phone) || null;
  },
  async setUser(phone, data) {
    if (db) return db.collection('users').doc(phone).set(data, { merge: true });
    mem.users.set(phone, { ...(mem.users.get(phone) || {}), ...data });
  },
  async addMsg(m) { if (db) await db.collection('messages').add(m); else mem.msgs.push(m); },
  async history(a, b) {
    const chat = [a, b].sort().join('|');
    let list;
    if (db) list = (await db.collection('messages').where('chat', '==', chat).limit(500).get()).docs.map(d => d.data());
    else list = mem.msgs.filter(m => m.chat === chat);
    return list.sort((x, y) => x.ts - y.ts);
  },
};

// ---------- SMS: plug your provider in here (Aliyun/Tencent SMS for China, Twilio/MSG91 for India) ----------
async function sendSms(phone, code) {
  console.log(`[DEV SMS] ${phone}: your code is ${code}`);
}

// ---------- Auth ----------
const PHONE = /^\+\d{8,15}$/;
const otps = new Map(); // phone -> {code, exp, tries, sent}

const app = express();
app.set('trust proxy', 1); // Caddy sits in front on AWS
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:",
  });
  if (PROD) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/health', (req, res) => res.send('ok'));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname + '/public'));

const ipHits = new Map(); // per-IP limit so nobody can run up your SMS bill
const tooMany = ip => { const n = Date.now(); const h = (ipHits.get(ip) || []).filter(t => n - t < 3600000); h.push(n); ipHits.set(ip, h); return h.length > 10; };
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of otps) if (n > v.exp) otps.delete(k);
  for (const [k, v] of ipHits) if (!v.some(t => n - t < 3600000)) ipHits.delete(k);
}, 600000).unref();

app.post('/api/otp', async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many requests. Try again later' });
  const { phone } = req.body || {};
  if (!PHONE.test(phone || '')) return res.status(400).json({ error: 'Use international format, e.g. +919876543210' });
  const prev = otps.get(phone);
  if (prev && Date.now() - prev.sent < 30000) return res.status(429).json({ error: 'Wait 30 seconds before asking for another code' });
  const code = String(crypto.randomInt(100000, 1000000));
  otps.set(phone, { code, exp: Date.now() + 5 * 60000, tries: 0, sent: Date.now() });
  await sendSms(phone, code);
  res.json({ ok: true, devCode: PROD ? undefined : code });
});

app.post('/api/verify', async (req, res) => {
  const { phone, code, publicKey } = req.body || {};
  const o = otps.get(phone);
  if (!o || Date.now() > o.exp || ++o.tries > 5) return res.status(400).json({ error: 'Code expired. Request a new one' });
  if (o.code !== code) return res.status(400).json({ error: 'Wrong code' });
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') return res.status(400).json({ error: 'Invalid key' });
  otps.delete(phone);
  await store.setUser(phone, { phone, publicKey, updated: Date.now() });
  res.json({ token: jwt.sign({ phone }, SECRET, { expiresIn: '30d' }) });
});

function auth(req, res, next) {
  try { req.phone = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).phone; next(); }
  catch { res.status(401).json({ error: 'Sign in again' }); }
}

app.get('/api/user/:phone', auth, async (req, res) => {
  const u = await store.getUser(req.params.phone);
  if (!u) return res.status(404).json({ error: 'This number has not joined yet' });
  res.json({ phone: u.phone, publicKey: u.publicKey });
});

app.get('/api/messages', auth, async (req, res) => {
  res.json(await store.history(req.phone, String(req.query.peer || '')));
});

// ---------- Realtime relay ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const online = new Map(); // phone -> Set<ws>

wss.on('connection', (ws, req) => {
  if (process.env.ALLOWED_ORIGIN && req.headers.origin !== process.env.ALLOWED_ORIGIN) return ws.close(4003, 'origin');
  let phone;
  try { phone = jwt.verify(new URL(req.url, 'http://x').searchParams.get('token'), SECRET).phone; }
  catch { return ws.close(4001, 'unauthorized'); }
  if (!online.has(phone)) online.set(phone, new Set());
  online.get(phone).add(ws);

  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type !== 'send' || !PHONE.test(m.to || '') || typeof m.ct !== 'string' || typeof m.iv !== 'string' || m.ct.length > 40000) return;
    if (!(await store.getUser(m.to))) return;
    const msg = { chat: [phone, m.to].sort().join('|'), from: phone, to: m.to, iv: m.iv, ct: m.ct, ts: Date.now() };
    await store.addMsg(msg);
    const out = JSON.stringify({ type: 'msg', msg });
    for (const p of [phone, m.to]) for (const s of online.get(p) || []) if (s.readyState === 1) s.send(out);
  });
  ws.on('close', () => { online.get(phone)?.delete(ws); });
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Listening on ${process.env.HOST || '0.0.0.0'}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
