import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { db } from './db.js';

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '../dist');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(HERE, '../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.set('trust proxy', 1);
app.disable('x-powered-by');

// A minimal, dependency-free security header set. CSP is fairly strict: only this origin, plus the
// Google Fonts CSS/font hosts the theme fonts load from, and unsafe-inline styles (styled-jsx and
// the motion/three libraries write inline style attributes, not <style> blocks with scripts).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "img-src 'self' data: blob:", "font-src 'self' https://fonts.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "script-src 'self'",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '256kb' }));

// A general per-IP request budget for every /api call, on top of the tighter login/signup throttle
// below. Crude (in-memory, resets on restart) but enough to blunt scraping or a runaway client —
// a single self-hosted instance doesn't need a Redis-backed limiter for this.
const buckets = new Map(); // ip -> timestamps within the current window
const rateLimited = (ip, max, windowMs) => {
  const now = Date.now(), a = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  a.push(now); buckets.set(ip, a);
  return a.length > max;
};
app.use('/api', (req, res, next) => (rateLimited(req.ip, 300, 60_000) ? res.status(429).json({ error: 'Too many requests. Slow down.' }) : next()));
setInterval(() => { // sweep so a long-running process doesn't leak memory over months (the auth-throttle maps below get their own sweep)
  const now = Date.now();
  for (const [k, a] of buckets) { const kept = a.filter((t) => now - t < 60_000); kept.length ? buckets.set(k, kept) : buckets.delete(k); }
}, 5 * 60_000).unref();

/* ---------- auth helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (p) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPw = (p, st) => {
  const [s, h] = st.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
};
const startSession = (res, uid) => {
  const t = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), uid, Date.now() + 30 * 864e5);
  res.cookie('mf', t, { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 30 * 864e5 });
};
const cookie = (req, n) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === n)?.[1];

app.use((req, _res, next) => {
  const t = cookie(req, 'mf');
  if (t) req.user = db.prepare(`SELECT u.id, u.callsign, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), Date.now());
  next();
});
const need = (role) => (req, res, next) => {
  if (!req.user || req.user.role === 'pending') return res.status(401).json({ error: 'Sign in required' });
  if (role === 'warden' && req.user.role !== 'warden') return res.status(403).json({ error: 'Warden only' });
  next();
};

// Brute-force defence, from three angles at once: a single IP guessing one callsign, a single IP
// spraying many callsigns, and one callsign being guessed from many IPs (a botnet spreading the
// attempts out specifically to dodge a per-IP limit). Each has its own budget and window.
const fails = { combo: new Map(), ip: new Map(), account: new Map(), signup: new Map() };
const LIMITS = { combo: [8, 6e5], ip: [20, 6e5], account: [15, 9e5], signup: [5, 36e5] }; // [max, windowMs]
const locked = (kind, key) => {
  const [max, windowMs] = LIMITS[kind], now = Date.now();
  return (fails[kind].get(key) || []).filter((t) => now - t < windowMs).length >= max;
};
const strike = (kind, key) => {
  const [, windowMs] = LIMITS[kind], now = Date.now();
  const a = (fails[kind].get(key) || []).filter((t) => now - t < windowMs);
  a.push(now); fails[kind].set(key, a);
};
// Paid once at boot: a scrypt hash of a password nobody knows. Checking a login against this when
// the callsign doesn't exist costs the same CPU time as checking a real password, so the response
// doesn't tip an attacker off to which callsigns are real accounts.
const DUMMY_HASH = hashPw(crypto.randomBytes(24).toString('hex'));

setInterval(() => { // sweep every tracked window so a long-running process doesn't leak memory over months
  const now = Date.now();
  for (const [kind, store] of Object.entries(fails)) {
    const windowMs = LIMITS[kind][1];
    for (const [k, a] of store) { const kept = a.filter((t) => now - t < windowMs); kept.length ? store.set(k, kept) : store.delete(k); }
  }
}, 5 * 60_000).unref();

/* ---------- auth routes ---------- */
app.post('/api/auth/signup', (req, res) => {
  if (locked('signup', req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a while.' });
  strike('signup', req.ip); // every attempt counts here, not just failures — this caps how fast the pending-approval queue can be flooded
  const c = String(req.body?.callsign || '').trim(), p = String(req.body?.passphrase || '');
  if (!/^[\w .'-]{2,32}$/.test(c) || p.length < 8) return res.status(400).json({ error: 'Callsign 2-32 chars; passphrase 8+ chars' });
  try {
    const r = db.transaction(() => {
      const first = !db.prepare('SELECT 1 FROM users LIMIT 1').get(); // first ever signup is the Warden
      const id = db.prepare('INSERT INTO users(callsign, pass_hash, role) VALUES(?,?,?)').run(c, hashPw(p), first ? 'warden' : 'pending').lastInsertRowid;
      return { id, first };
    })();
    if (r.first) { startSession(res, r.id); return res.status(201).json({ status: 'warden' }); }
    res.status(202).json({ status: 'pending' });
  } catch { res.status(409).json({ error: 'Callsign already taken' }); }
});

app.post('/api/auth/login', (req, res) => {
  const c = String(req.body?.callsign || '').trim(), p = String(req.body?.passphrase || '');
  const ip = req.ip, combo = ip + '|' + c.toLowerCase(), account = c.toLowerCase();
  if (locked('combo', combo) || locked('ip', ip) || locked('account', account)) return res.status(429).json({ error: 'Too many attempts. Wait a while.' });
  const u = db.prepare('SELECT * FROM users WHERE callsign = ?').get(c);
  const ok = u ? checkPw(p, u.pass_hash) : (checkPw(p, DUMMY_HASH), false); // always pay the scrypt cost, real account or not
  if (!ok) { strike('combo', combo); strike('ip', ip); strike('account', account); return res.status(401).json({ error: 'Callsign or passphrase not recognised' }); }
  if (u.role === 'pending') return res.status(403).json({ error: 'Awaiting the Warden' });
  startSession(res, u.id);
  res.json({ id: u.id, callsign: u.callsign, role: u.role });
});

app.post('/api/auth/logout', (req, res) => {
  const t = cookie(req, 'mf'); if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.clearCookie('mf').json({ ok: true });
});
app.get('/api/me', need(), (req, res) => res.json(req.user));
app.patch('/api/me/callsign', need(), (req, res) => {
  const c = String(req.body?.callsign || '').trim();
  if (!/^[\w .'-]{2,32}$/.test(c)) return res.status(400).json({ error: 'Callsign 2-32 chars' });
  try { db.prepare('UPDATE users SET callsign = ? WHERE id = ?').run(c, req.user.id); res.json({ ok: true }); }
  catch { res.status(409).json({ error: 'That callsign is taken' }); }
});
app.post('/api/me/password', need(), (req, res) => {
  const u = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!checkPw(String(req.body?.current || ''), u.pass_hash)) return res.status(401).json({ error: 'Current passphrase is wrong' });
  const next = String(req.body?.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'New passphrase needs 8+ characters' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPw(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha(cookie(req, 'mf')));
  res.json({ ok: true });
});

/* ---------- personnel (Warden) ---------- */
app.get('/api/users', need('warden'), (_req, res) => res.json(db.prepare('SELECT id, callsign, role, created_at FROM users ORDER BY id').all()));
app.patch('/api/users/:id', need('warden'), (req, res) => {
  const id = +req.params.id, role = req.body?.role;
  if (!['warden', 'agent', 'pending'].includes(role)) return res.status(400).json({ error: 'Bad role' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (role === 'pending') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // suspension logs them out
  res.json({ ok: true });
});
app.delete('/api/users/:id', need('warden'), (req, res) => { // deny an application; only pending accounts (they own no reports)
  const r = db.prepare("DELETE FROM users WHERE id = ? AND role = 'pending'").run(+req.params.id);
  res.status(r.changes ? 200 : 400).json({ ok: !!r.changes });
});

/* ---------- categories & tags ---------- */
app.get('/api/tags', need(), (_req, res) => {
  // A redacted person's tag is left off this list for everyone, Wardens included: this is what
  // powers tag *picking and filtering* (Compose, the archive filter), and the point of redacting
  // is that the tag stops being something you can pick. A Warden still sees it on a report that
  // already carries it (hydrate(), below) and can manage it from Persons of interest -> show redacted.
  const rows = db.prepare(`SELECT c.id AS cid, c.name AS category, t.id, t.name, p.aliases, p.deleted_at FROM categories c LEFT JOIN tags t ON t.category_id = c.id LEFT JOIN poi_profiles p ON p.tag_id = t.id ORDER BY c.id, t.name`).all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.cid)) out.set(r.cid, { id: r.cid, name: r.category, tags: [] });
    if (r.id && !r.deleted_at) out.get(r.cid).tags.push({ id: r.id, name: r.name, aliases: r.aliases || '' });
  }
  res.json([...out.values()]);
});
app.post('/api/tags', need(), (req, res) => {
  const c = String(req.body?.category || '').trim().slice(0, 40), n = String(req.body?.name || '').trim().slice(0, 40);
  if (!c || !n) return res.status(400).json({ error: 'Category and tag name required' });
  const id = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(c);
    const cid = db.prepare('SELECT id FROM categories WHERE name = ?').get(c).id;
    db.prepare('INSERT OR IGNORE INTO tags(category_id, name) VALUES(?,?)').run(cid, n);
    const tid = db.prepare('SELECT id FROM tags WHERE category_id = ? AND name = ?').get(cid, n).id;
    backfill(tid); return tid;
  })();
  res.status(201).json({ id });
});
app.delete('/api/tags/:id', need('warden'), (req, res) => {
  const id = +req.params.id;
  const t = db.prepare('SELECT c.name AS category FROM tags t JOIN categories c ON c.id = t.category_id WHERE t.id = ?').get(id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.category === 'Person') return res.status(400).json({ error: 'Persons of interest keep a permanent file; edit or ignore it instead of deleting the tag' });
  db.transaction(() => {
    db.prepare('DELETE FROM report_tags WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  })(); // the tag's NAME can be reused later — posting it again re-tags every report that still mentions it (see backfill)
  res.json({ ok: true });
});

/* ---------- reports ---------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesOf = (t) => [t.name, ...String(t.aliases || '').split(',').map((a) => a.trim())].filter(Boolean);
const mentions = (t, text) => namesOf(t).some((n) => new RegExp(`\\b${esc(n)}(e?s)?\\b`, 'i').test(text));
const TAGS = 'SELECT t.id, t.name, p.aliases, p.deleted_at FROM tags t LEFT JOIN poi_profiles p ON p.tag_id = t.id';
const tagText = (rid, text, manual = []) => { // tags are only ever added to a report, never removed
  const ins = db.prepare('INSERT OR IGNORE INTO report_tags(report_id, tag_id, auto) SELECT ?, id, ? FROM tags WHERE id = ?');
  db.prepare(TAGS).all().filter((t) => !t.deleted_at && mentions(t, text)).forEach((t) => ins.run(rid, 1, t.id)); // a redacted person is never auto-tagged
  manual.forEach((t) => ins.run(rid, 0, t));
};
const backfill = (tagId) => { // a new tag or person also claims older reports that mention it
  const t = db.prepare(TAGS + ' WHERE t.id = ?').get(tagId); if (!t) return;
  const ins = db.prepare('INSERT OR IGNORE INTO report_tags(report_id, tag_id, auto) VALUES(?,?,1)');
  db.prepare(`SELECT id AS rid, title || ' ' || body AS x FROM reports UNION ALL SELECT report_id, title || ' ' || body FROM report_revisions
    UNION ALL SELECT report_id, body FROM addenda`).all().forEach((r) => mentions(t, r.x) && ins.run(r.rid, tagId));
};
const CONF = ['rumour', 'witnessed', 'confirmed'];
const conf = (c) => (CONF.includes(c) ? c : null);
const srcId = (n) => { n = String(n || '').trim().slice(0, 60); if (!n) return null; db.prepare('INSERT OR IGNORE INTO sources(name) VALUES(?)').run(n); return db.prepare('SELECT id FROM sources WHERE name = ?').get(n).id; };

const SELECT = `SELECT r.id, r.title, r.body, r.confidence, s.name AS source, r.created_at, r.filed_at, r.deleted_at, u.callsign AS author
  FROM reports r JOIN users u ON u.id = r.author_id LEFT JOIN sources s ON s.id = r.source_id`;
const hydrate = (rows, role = 'agent') => { // each report comes back as a full case file: current text, history, addenda, links
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id), m = ids.map(() => '?').join(), all = (sql, ...p) => db.prepare(sql).all(...p);
  const tg = all(`SELECT rt.report_id, rt.auto, t.id, t.name, c.name AS category, p.deleted_at AS poi_deleted FROM report_tags rt JOIN tags t ON t.id = rt.tag_id JOIN categories c ON c.id = t.category_id LEFT JOIN poi_profiles p ON p.tag_id = t.id WHERE rt.report_id IN (${m})`, ...ids);
  const rv = all(`SELECT v.id, v.report_id, v.title, v.body, v.confidence, s.name AS source, v.note, v.edited_at, u.callsign AS editor FROM report_revisions v JOIN users u ON u.id = v.edited_by LEFT JOIN sources s ON s.id = v.source_id WHERE v.report_id IN (${m}) ORDER BY v.id`, ...ids);
  const at = all(`SELECT id, report_id, original_name, mime, size, created_at FROM attachments WHERE report_id IN (${m}) AND deleted_at IS NULL ORDER BY id`, ...ids);
  const ad = all(`SELECT n.id, n.report_id, n.body, n.confidence, s.name AS source, n.created_at, u.callsign AS author FROM addenda n JOIN users u ON u.id = n.author_id LEFT JOIN sources s ON s.id = n.source_id WHERE n.report_id IN (${m}) ORDER BY n.id`, ...ids);
  const lk = all(`SELECT a, b FROM report_links WHERE a IN (${m}) OR b IN (${m})`, ...ids, ...ids);
  const lids = [...new Set(lk.flatMap((l) => [l.a, l.b]))];
  const titles = lids.length ? Object.fromEntries(all(`SELECT x.id, COALESCE((SELECT v.title FROM report_revisions v WHERE v.report_id = x.id ORDER BY v.id DESC LIMIT 1), x.title) AS title
    FROM reports x WHERE x.id IN (${lids.map(() => '?').join()})`, ...lids).map((x) => [x.id, x.title])) : {};
  return rows.map((r) => {
    const v = rv.filter((x) => x.report_id === r.id), c = v.at(-1);
    return {
      ...r, original: { title: r.title, body: r.body, confidence: r.confidence, source: r.source },
      ...(c ? { title: c.title, body: c.body, confidence: c.confidence, source: c.source } : {}),
      tags: tg.filter((x) => x.report_id === r.id && !(x.poi_deleted && role !== 'warden')) // a redacted person's tag is hidden from non-Wardens
        .map(({ poi_deleted, ...x }) => x),
      revisions: [...v].reverse(), attachments: at.filter((x) => x.report_id === r.id), addenda: ad.filter((x) => x.report_id === r.id),
      links: lk.filter((l) => l.a === r.id || l.b === r.id).map((l) => { const o = l.a === r.id ? l.b : l.a; return { id: o, title: titles[o] }; }),
    };
  });
};
const one = (id, role) => hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(id), role)[0];
const exists = (req, res, next) => (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(+req.params.id) ? next() : res.status(404).json({ error: 'Not found' }));

app.post('/api/reports', need(), (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200), body = String(req.body?.body || '').slice(0, 20000);
  if (!title || !body.trim()) return res.status(400).json({ error: 'Title and body required' });
  const occ = req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date(); // when it happened (retroactive filing allowed)
  if (isNaN(occ) || occ > Date.now() + 3e5) return res.status(400).json({ error: 'Invalid or future event time' });
  const manual = Array.isArray(req.body?.tagIds) ? req.body.tagIds.filter(Number.isInteger) : [];
  const id = db.transaction(() => {
    const rid = db.prepare('INSERT INTO reports(title, body, author_id, created_at, confidence, source_id) VALUES(?,?,?,?,?,?)')
      .run(title, body, req.user.id, occ.toISOString(), conf(req.body.confidence), srcId(req.body.source)).lastInsertRowid;
    tagText(rid, title + ' ' + body, manual);
    return rid;
  })();
  res.status(201).json(one(id, req.user.role));
});

/* Any agent may amend a report. The original and every revision are kept forever; the latest one is what is shown. */
app.post('/api/reports/:id/edit', need(), exists, (req, res) => {
  const id = +req.params.id, cur = one(id, req.user.role), b = req.body || {};
  const title = String(b.title ?? cur.title).trim().slice(0, 200), body = String(b.body ?? cur.body).slice(0, 20000);
  if (!title || !body.trim()) return res.status(400).json({ error: 'Title and body required' });
  db.transaction(() => {
    db.prepare('INSERT INTO report_revisions(report_id, title, body, confidence, source_id, note, edited_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, title, body, conf(b.confidence), srcId(b.source), String(b.note || '').slice(0, 200), req.user.id);
    tagText(id, title + ' ' + body);
  })();
  res.json(one(id, req.user.role));
});
/* An addendum is a follow-up note pinned to a report — a later source adding detail without rewriting
   the original. Unlike an edit, it doesn't replace anything, and unlike an edit it can never be
   changed or removed once posted (add_no_upd/add_no_del in db.js) — it's a dated statement from
   whoever posted it, on the record. */
app.post('/api/reports/:id/addenda', need(), exists, (req, res) => {
  const id = +req.params.id, r = db.prepare('SELECT deleted_at FROM reports WHERE id = ?').get(id);
  if (r.deleted_at) return res.status(400).json({ error: 'That report is redacted' });
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'An addendum needs some text' });
  db.transaction(() => {
    db.prepare('INSERT INTO addenda(report_id, body, confidence, source_id, author_id) VALUES(?,?,?,?,?)')
      .run(id, body, conf(req.body.confidence), srcId(req.body.source), req.user.id);
    tagText(id, body); // names mentioned in the addendum tag the report too
  })();
  res.status(201).json(one(id, req.user.role));
});
app.post('/api/reports/:id/links', need(), exists, (req, res) => {
  const a = +req.params.id, b = +req.body?.toId;
  if (!b || a === b || !db.prepare('SELECT 1 FROM reports WHERE id = ?').get(b)) return res.status(400).json({ error: 'Pick another report' });
  db.prepare('INSERT OR IGNORE INTO report_links(a, b, linked_by) VALUES(?,?,?)').run(Math.min(a, b), Math.max(a, b), req.user.id);
  res.json(one(a, req.user.role));
});
app.get('/api/sources', need(), (_req, res) => res.json(db.prepare('SELECT name FROM sources ORDER BY name').all().map((x) => x.name)));

/* ---------- attachments: PDFs and images clipped to a report ---------- */
const ATTACH_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(20).toString('hex') + path.extname(file.originalname).slice(0, 10)),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ATTACH_MIME.has(file.mimetype)),
});
app.post('/api/reports/:id/attachments', need(), exists, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over the 20MB limit' : 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'Only PDF, PNG, JPEG, WebP or GIF files are accepted' });
    const r = db.prepare('SELECT deleted_at FROM reports WHERE id = ?').get(+req.params.id);
    if (r.deleted_at) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'That report is redacted' }); }
    db.prepare('INSERT INTO attachments(report_id, filename, original_name, mime, size, uploaded_by) VALUES(?,?,?,?,?,?)')
      .run(+req.params.id, req.file.filename, req.file.originalname.slice(0, 200), req.file.mimetype, req.file.size, req.user.id);
    res.status(201).json(one(+req.params.id, req.user.role));
  });
});
app.get('/api/attachments/:id', need(), (req, res) => {
  const a = db.prepare(`SELECT a.*, r.deleted_at AS report_deleted FROM attachments a JOIN reports r ON r.id = a.report_id WHERE a.id = ?`).get(+req.params.id);
  if (!a || ((a.deleted_at || a.report_deleted) && req.user.role !== 'warden')) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', a.mime);
  res.setHeader('Content-Disposition', `inline; filename="${a.original_name.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(UPLOAD_DIR, a.filename), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});
app.post('/api/attachments/:id/remove', need(), (req, res) => { // soft-remove: the file and row stay, just hidden from the case file
  const a = db.prepare(`SELECT a.report_id, r.deleted_at AS report_deleted FROM attachments a JOIN reports r ON r.id = a.report_id WHERE a.id = ?`).get(+req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (a.report_deleted && req.user.role !== 'warden') return res.status(403).json({ error: 'That report is redacted' }); // same rule as editing a report
  db.prepare('UPDATE attachments SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), req.user.id, +req.params.id);
  res.json(one(a.report_id, req.user.role));
});

/* Persons of interest are tags in the "Person" category with a profile, so name and alias mentions link reports automatically.
   Redacting a file hides the person and their tag from ordinary use without ever touching poi_revisions' permanent history. */
app.get('/api/pois', need(), (req, res) => {
  const showRedacted = req.query.deleted === '1' && req.user.role === 'warden';
  res.json(db.prepare(`SELECT t.id, t.name, COALESCE(p.description,'') AS description, COALESCE(p.aliases,'') AS aliases, p.deleted_at, COUNT(r.id) AS n
    FROM tags t JOIN categories c ON c.id = t.category_id AND c.name = 'Person' LEFT JOIN poi_profiles p ON p.tag_id = t.id
    LEFT JOIN report_tags rt ON rt.tag_id = t.id LEFT JOIN reports r ON r.id = rt.report_id AND r.deleted_at IS NULL
    ${showRedacted ? '' : 'WHERE p.deleted_at IS NULL'} GROUP BY t.id ORDER BY n DESC, t.name`).all());
});
const savePoi = (tagId, b, uid) => {
  db.prepare('INSERT INTO poi_revisions(tag_id, description, aliases, edited_by) VALUES(?,?,?,?)').run(tagId, String(b.description || '').slice(0, 4000), String(b.aliases || '').slice(0, 300), uid); // every version of a file is kept
  db.prepare(`INSERT INTO poi_profiles(tag_id, description, aliases) VALUES(?,?,?) ON CONFLICT(tag_id) DO UPDATE SET description = excluded.description, aliases = excluded.aliases`)
    .run(tagId, String(b.description || '').slice(0, 4000), String(b.aliases || '').slice(0, 300));
  backfill(tagId);
};
app.post('/api/pois', need(), (req, res) => {
  const n = String(req.body?.name || '').trim().slice(0, 60);
  if (!n) return res.status(400).json({ error: 'A name is required' });
  const id = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO categories(name) VALUES('Person')").run();
    const cid = db.prepare("SELECT id FROM categories WHERE name = 'Person'").get().id;
    db.prepare('INSERT OR IGNORE INTO tags(category_id, name) VALUES(?,?)').run(cid, n);
    const tid = db.prepare('SELECT id FROM tags WHERE category_id = ? AND name = ?').get(cid, n).id;
    savePoi(tid, req.body, req.user.id); return tid;
  })();
  res.status(201).json({ id });
});
app.put('/api/pois/:id', need(), (req, res) => { savePoi(+req.params.id, req.body || {}, req.user.id); res.json({ ok: true }); });
app.post('/api/pois/:id/redact', need('warden'), (req, res) => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO poi_profiles(tag_id, description, aliases, deleted_at, deleted_by) VALUES(?, '', '', ?, ?)
    ON CONFLICT(tag_id) DO UPDATE SET deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by`).run(+req.params.id, now, req.user.id);
  res.json({ ok: true });
});
app.post('/api/pois/:id/restore', need('warden'), (req, res) => {
  db.prepare('UPDATE poi_profiles SET deleted_at = NULL, deleted_by = NULL WHERE tag_id = ?').run(+req.params.id);
  res.json({ ok: true });
});

app.get('/api/reports', need(), (req, res) => {
  const { q, tags, deleted, limit, offset } = req.query, w = [], a = [];
  if (!(deleted === '1' && req.user.role === 'warden')) w.push('r.deleted_at IS NULL');
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu);
  if (words) { // searches originals, every revision, and every addendum
    const f = words.map((t) => `"${t}"*`).join(' ');
    w.push(`(r.id IN (SELECT rowid FROM reports_fts WHERE reports_fts MATCH ?) OR r.id IN (SELECT report_id FROM report_revisions WHERE id IN (SELECT rowid FROM rev_fts WHERE rev_fts MATCH ?))
      OR r.id IN (SELECT report_id FROM addenda WHERE id IN (SELECT rowid FROM add_fts WHERE add_fts MATCH ?)))`);
    a.push(f, f, f);
  }
  for (const t of String(tags || '').split(',').filter(Boolean)) { w.push('r.id IN (SELECT report_id FROM report_tags WHERE tag_id = ?)'); a.push(+t); }
  const rows = db.prepare(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
    .all(...a, Math.min(+limit || 50, 200), +offset || 0);
  res.json(hydrate(rows, req.user.role));
});

app.get('/api/reports/:id', need(), (req, res) => {
  const r = hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(+req.params.id), req.user.role)[0];
  if (!r || (r.deleted_at && req.user.role !== 'warden')) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.post('/api/reports/:id/redact', need(), (req, res) => { // soft delete
  const r = db.prepare('SELECT author_id FROM reports WHERE id = ?').get(+req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.author_id !== req.user.id && req.user.role !== 'warden') return res.status(403).json({ error: 'Not yours to redact' });
  db.prepare("UPDATE reports SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL").run(req.user.id, +req.params.id);
  res.json({ ok: true });
});
app.post('/api/reports/:id/restore', need('warden'), (req, res) => {
  db.prepare('UPDATE reports SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

/* ---------- per-user settings (theme + font) ---------- */
const THEMES = ['nocturne', 'parchment', 'stormcloak', 'thalmor', 'imperial', 'college', 'forsworn', 'blackreach'], FONTS = ['ledger', 'typewriter', 'clean'];
app.get('/api/settings', need(), (req, res) => {
  const r = db.prepare('SELECT json FROM user_settings WHERE user_id = ?').get(req.user.id);
  res.json({ theme: 'nocturne', font: 'ledger', animate: true, clickSpark: true, ...(r ? JSON.parse(r.json) : {}) });
});
app.put('/api/settings', need(), (req, res) => {
  const { theme, font, animate = true, clickSpark = true } = req.body || {};
  if (!THEMES.includes(theme) || !FONTS.includes(font)) return res.status(400).json({ error: 'Unknown theme or font' });
  const out = { theme, font, animate: !!animate, clickSpark: !!clickSpark };
  db.prepare('INSERT INTO user_settings(user_id, json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json').run(req.user.id, JSON.stringify(out));
  res.json(out);
});

/* ---------- stats for dashboard ---------- */
app.get('/api/stats/heatmap', need(), (_req, res) => // day buckets in Skyrim time (UTC-5)
  res.json(db.prepare(`SELECT date(created_at, '-5 hours') AS day, COUNT(*) AS n FROM reports
    WHERE deleted_at IS NULL AND created_at >= date('now', '-380 days') GROUP BY day`).all()));
app.get('/api/stats/tags', need(), (_req, res) => // counts per tag: powers the map pins and tag chips. Redacted persons never appear here.
  res.json(db.prepare(`SELECT t.id, t.name, c.name AS category, COUNT(r.id) AS n FROM tags t
    JOIN categories c ON c.id = t.category_id LEFT JOIN poi_profiles p ON p.tag_id = t.id LEFT JOIN report_tags rt ON rt.tag_id = t.id
    LEFT JOIN reports r ON r.id = rt.report_id AND r.deleted_at IS NULL
    WHERE p.deleted_at IS NULL GROUP BY t.id`).all()));

/* ---------- serve the built React app ---------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'No such route' }));
app.use(express.static(DIST, { maxAge: PROD ? '1y' : 0, index: false })); // index.html is served fresh below, never cached
app.use((_req, res) => res.sendFile(path.join(DIST, 'index.html')));

// Catches malformed JSON bodies, thrown errors from route handlers (better-sqlite3 is synchronous,
// so a bad query or constraint violation throws rather than rejecting), and anything else that
// reaches here. Never leaks a stack trace to the client; always logs it server-side.
app.use((err, req, res, _next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ error: status === 500 ? 'Something went wrong on our end' : (err.message || 'Bad request') });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Manifesto listening on :${port}`));
