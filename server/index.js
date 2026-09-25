import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { db, COVER_NAMES, hardDelete, cascadeDelete } from './db.js';

const MAX_CLEARANCE = 5; // 0 = everyone, 5 = Warden-tier
const REVEAL_CLEARANCE = 3; // clearance level at which the "Manifesto" brand itself stops being hidden

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
  if (t) req.user = db.prepare(`SELECT u.id, u.callsign, u.role, u.clearance, u.cover_name FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(t), Date.now());
  // The brand itself is part of what clearance gates: below the reveal level (and not the Warden),
  // the header shows a cover name instead of "Manifesto" — see the user's "Also new idea" spec.
  if (req.user) req.user.brand = (req.user.role === 'warden' || req.user.clearance >= REVEAL_CLEARANCE) ? 'Manifesto' : (req.user.cover_name || 'Manifesto');
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
      const cover = COVER_NAMES[Math.floor(Math.random() * COVER_NAMES.length)]; // fixed for the life of the account
      const id = db.prepare('INSERT INTO users(callsign, pass_hash, role, clearance, cover_name) VALUES(?,?,?,?,?)')
        .run(c, hashPw(p), first ? 'warden' : 'pending', first ? MAX_CLEARANCE : 0, cover).lastInsertRowid;
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
app.get('/api/users', need('warden'), (_req, res) => res.json(db.prepare('SELECT id, callsign, role, clearance, created_at FROM users ORDER BY id').all()));
app.patch('/api/users/:id', need('warden'), (req, res) => {
  const id = +req.params.id, role = req.body?.role;
  if (!['warden', 'agent', 'pending'].includes(role)) return res.status(400).json({ error: 'Bad role' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (role === 'pending') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // suspension logs them out
  res.json({ ok: true });
});
app.patch('/api/users/:id/clearance', need('warden'), (req, res) => {
  const id = +req.params.id, clearance = parseInt(req.body?.clearance, 10);
  if (!Number.isInteger(clearance) || clearance < 0 || clearance > MAX_CLEARANCE) return res.status(400).json({ error: `Clearance must be 0-${MAX_CLEARANCE}` });
  db.prepare('UPDATE users SET clearance = ? WHERE id = ?').run(clearance, id);
  res.json({ ok: true });
});
app.delete('/api/users/:id', need('warden'), (req, res) => { // deny an application; a pending account that never authored anything can go away cleanly
  const id = +req.params.id;
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.role !== 'pending') return res.status(400).json({ error: 'Only a pending application can be denied this way — suspend an existing account instead' });
  // A pending account can still be one this Warden earlier suspended, and a suspended agent may
  // have filed reports, revisions, addenda, attachments or person-of-interest history while active —
  // all of which are permanent records that reference their author. Rather than let the delete hit
  // that foreign-key wall as a raw 500, check for it up front and explain why they can only be
  // suspended, not removed.
  const authored = db.prepare(`SELECT
      (SELECT 1 FROM reports WHERE author_id = ?) OR
      (SELECT 1 FROM report_revisions WHERE edited_by = ?) OR
      (SELECT 1 FROM addenda WHERE author_id = ?) OR
      (SELECT 1 FROM attachments WHERE uploaded_by = ?) OR
      (SELECT 1 FROM poi_revisions WHERE edited_by = ?) AS any`).get(id, id, id, id, id).any;
  if (authored) return res.status(400).json({ error: 'This callsign has filed reports of their own — that history is permanent, so the account can only stay suspended, not be removed' });
  // A notes thread is a permanent record too, but unlike reports it has no author-history reason to
  // block removal — it just needs to survive the account going away. Snapshot the callsign into
  // member_label (so a Warden can still tell whose thread it was) and clear the pointers that would
  // otherwise foreign-key-block the delete below.
  const callsign = db.prepare('SELECT callsign FROM users WHERE id = ?').get(id)?.callsign || null;
  const changes = db.transaction(() => {
    db.prepare('UPDATE notes_threads SET member_id = NULL, member_label = COALESCE(member_label, ?) WHERE member_id = ?').run(callsign, id);
    db.prepare('UPDATE notes_messages SET author_id = NULL WHERE author_id = ?').run(id);
    return db.prepare("DELETE FROM users WHERE id = ? AND role = 'pending'").run(id).changes;
  })();
  res.status(changes ? 200 : 400).json({ ok: !!changes });
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

// A word-for-word scramble: every run of letters/digits becomes random characters of random
// length, so a locked-out reader can tell a report exists and roughly how long it is — nothing
// more. Case of the first letter is kept so the scramble doesn't visibly flatten sentence starts.
const scrambleWord = (w) => {
  let out = ''; for (let i = 0, n = 2 + Math.floor(Math.random() * 9); i < n; i++) out += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return /^[\p{Lu}]/u.test(w) ? out[0].toUpperCase() + out.slice(1) : out;
};
const scramble = (s) => String(s || '').replace(/[\p{L}\p{N}]+/gu, scrambleWord);

const SELECT = `SELECT r.id, r.title, r.body, r.confidence, s.name AS source, r.created_at, r.filed_at, r.deleted_at, r.author_id, r.clearance, u.callsign AS author
  FROM reports r JOIN users u ON u.id = r.author_id LEFT JOIN sources s ON s.id = r.source_id`;
// `viewer` is the signed-in user (req.user) — or omitted for internal/warden-equivalent use. Every
// report comes back as a full case file for someone cleared to read it (current text, history,
// addenda); for anyone else it comes back scrambled: title/body reduced to gibberish of the
// same rough shape, tags trimmed to Hold only (never a Person tag — that could be reverse-engineered
// back into who it's about), and history/addenda/attachments/author/source withheld entirely.
const hydrate = (rows, viewer) => {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id), m = ids.map(() => '?').join(), all = (sql, ...p) => db.prepare(sql).all(...p);
  const tg = all(`SELECT rt.report_id, rt.auto, t.id, t.name, c.name AS category, p.deleted_at AS poi_deleted FROM report_tags rt JOIN tags t ON t.id = rt.tag_id JOIN categories c ON c.id = t.category_id LEFT JOIN poi_profiles p ON p.tag_id = t.id WHERE rt.report_id IN (${m})`, ...ids);
  const rv = all(`SELECT v.id, v.report_id, v.title, v.body, v.confidence, s.name AS source, v.note, v.edited_at, u.callsign AS editor FROM report_revisions v JOIN users u ON u.id = v.edited_by LEFT JOIN sources s ON s.id = v.source_id WHERE v.report_id IN (${m}) ORDER BY v.id`, ...ids);
  const at = all(`SELECT id, report_id, original_name, mime, size, created_at FROM attachments WHERE report_id IN (${m}) AND deleted_at IS NULL ORDER BY id`, ...ids);
  const ad = all(`SELECT n.id, n.report_id, n.body, n.confidence, s.name AS source, n.created_at, u.callsign AS author FROM addenda n JOIN users u ON u.id = n.author_id LEFT JOIN sources s ON s.id = n.source_id WHERE n.report_id IN (${m}) ORDER BY n.id`, ...ids);
  const role = viewer?.role;
  const grantedIds = viewer && role !== 'warden'
    ? new Set(all(`SELECT report_id FROM access_grants WHERE user_id = ? AND report_id IN (${m})`, viewer.id, ...ids).map((g) => g.report_id))
    : null;
  // A viewer's own read-state (report_reads, db.js) — purely a per-viewer convenience marker, never
  // part of the permanent record — powers the unread dot on a report they're cleared for but haven't
  // opened yet. Only meaningful once a report is actually readable, so it's left off a scrambled one.
  const readIds = viewer ? new Set(all(`SELECT report_id FROM report_reads WHERE user_id = ? AND report_id IN (${m})`, viewer.id, ...ids).map((x) => x.report_id)) : null;
  return rows.map((r) => {
    const full = !viewer || role === 'warden' || r.author_id === viewer.id || r.clearance <= (viewer.clearance || 0) || grantedIds.has(r.id);
    const v = rv.filter((x) => x.report_id === r.id), c = v.at(-1);
    const tags = tg.filter((x) => x.report_id === r.id && !(x.poi_deleted && role !== 'warden')) // a redacted person's tag is hidden from non-Wardens
      .map(({ poi_deleted, ...x }) => x)
      .filter((x) => full || x.category === 'Hold');
    if (!full) {
      // The clearance a locked report requires is never handed to someone who doesn't have it —
      // "you lack the clearance" is all they get, not which level would have been enough.
      return {
        id: r.id, scrambled: true, created_at: r.created_at, filed_at: r.filed_at, deleted_at: r.deleted_at,
        title: scramble(c ? c.title : r.title), body: scramble(c ? c.body : r.body), tags,
        revisions: [], addenda: [], attachments: [],
      };
    }
    return {
      ...r, original: { title: r.title, body: r.body, confidence: r.confidence, source: r.source },
      ...(c ? { title: c.title, body: c.body, confidence: c.confidence, source: c.source } : {}),
      tags, unread: !!viewer && !readIds.has(r.id),
      revisions: [...v].reverse(), attachments: at.filter((x) => x.report_id === r.id), addenda: ad.filter((x) => x.report_id === r.id),
    };
  });
};
const one = (id, viewer) => hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(id), viewer)[0];
const exists = (req, res, next) => (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(+req.params.id) ? next() : res.status(404).json({ error: 'Not found' }));
// Same full-access test hydrate() uses, as a quick gate for the write routes below — you can't
// amend, addend or attach to a report you aren't cleared to actually read.
const cleared = (id, viewer) => {
  const r = db.prepare('SELECT author_id, clearance FROM reports WHERE id = ?').get(id);
  return !r || viewer.role === 'warden' || r.author_id === viewer.id || r.clearance <= (viewer.clearance || 0)
    || !!db.prepare('SELECT 1 FROM access_grants WHERE report_id = ? AND user_id = ?').get(id, viewer.id);
};

app.post('/api/reports', need(), (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200), body = String(req.body?.body || '').slice(0, 20000);
  if (!title || !body.trim()) return res.status(400).json({ error: 'Title and body required' });
  const occ = req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date(); // when it happened (retroactive filing allowed)
  if (isNaN(occ) || occ > Date.now() + 3e5) return res.status(400).json({ error: 'Invalid or future event time' });
  const manual = Array.isArray(req.body?.tagIds) ? req.body.tagIds.filter(Number.isInteger) : [];
  // An agent's own filing is always locked to the highest clearance — Warden-only — so agents never
  // see each other's reports by default, only their own; a Warden can loosen that afterward (below).
  // Only a Warden can choose a lower clearance at filing time.
  const clearance = req.user.role === 'warden'
    ? Math.max(0, Math.min(MAX_CLEARANCE, parseInt(req.body?.clearance, 10) || 0))
    : MAX_CLEARANCE;
  const id = db.transaction(() => {
    const rid = db.prepare('INSERT INTO reports(title, body, author_id, created_at, confidence, source_id, clearance) VALUES(?,?,?,?,?,?,?)')
      .run(title, body, req.user.id, occ.toISOString(), conf(req.body.confidence), srcId(req.body.source), clearance).lastInsertRowid;
    tagText(rid, title + ' ' + body, manual);
    return rid;
  })();
  res.status(201).json(one(id, req.user));
});

/* Any agent may amend a report. The original and every revision are kept forever; the latest one is what is shown. */
app.post('/api/reports/:id/edit', need(), exists, (req, res) => {
  const id = +req.params.id, cur = one(id, req.user), b = req.body || {};
  if (cur.scrambled) return res.status(403).json({ error: 'You are not cleared to read this report' }); // can't fill in a scrambled title/body as a default, and shouldn't amend what you can't read
  const title = String(b.title ?? cur.title).trim().slice(0, 200), body = String(b.body ?? cur.body).slice(0, 20000);
  if (!title || !body.trim()) return res.status(400).json({ error: 'Title and body required' });
  // Ordinary edits are still add-only by mention (tagText, below) — this is the escape hatch: a
  // tag explicitly picked here is added even without a mention, and one explicitly removed here
  // comes off even if the new text still mentions it, since that's a deliberate call, not a miss.
  const addIds = Array.isArray(b.addTagIds) ? b.addTagIds.filter(Number.isInteger) : [];
  const removeIds = Array.isArray(b.removeTagIds) ? b.removeTagIds.filter(Number.isInteger) : [];
  db.transaction(() => {
    db.prepare('INSERT INTO report_revisions(report_id, title, body, confidence, source_id, note, edited_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, title, body, conf(b.confidence), srcId(b.source), String(b.note || '').slice(0, 200), req.user.id);
    tagText(id, title + ' ' + body, addIds);
    if (removeIds.length) {
      const del = db.prepare('DELETE FROM report_tags WHERE report_id = ? AND tag_id = ?');
      for (const tid of removeIds) del.run(id, tid);
    }
  })();
  res.json(one(id, req.user));
});
/* An addendum is a follow-up note pinned to a report — a later source adding detail without rewriting
   the original. Unlike an edit, it doesn't replace anything, and unlike an edit it can never be
   changed or removed once posted (add_no_upd/add_no_del in db.js) — it's a dated statement from
   whoever posted it, on the record. */
app.post('/api/reports/:id/addenda', need(), exists, (req, res) => {
  const id = +req.params.id, r = db.prepare('SELECT deleted_at FROM reports WHERE id = ?').get(id);
  if (r.deleted_at) return res.status(400).json({ error: 'That report is redacted' });
  if (!cleared(id, req.user)) return res.status(403).json({ error: 'You are not cleared to read this report' });
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'An addendum needs some text' });
  db.transaction(() => {
    db.prepare('INSERT INTO addenda(report_id, body, confidence, source_id, author_id) VALUES(?,?,?,?,?)')
      .run(id, body, conf(req.body.confidence), srcId(req.body.source), req.user.id);
    tagText(id, body); // names mentioned in the addendum tag the report too
  })();
  res.status(201).json(one(id, req.user));
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
    if (!cleared(+req.params.id, req.user)) { fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'You are not cleared to read this report' }); }
    db.prepare('INSERT INTO attachments(report_id, filename, original_name, mime, size, uploaded_by) VALUES(?,?,?,?,?,?)')
      .run(+req.params.id, req.file.filename, req.file.originalname.slice(0, 200), req.file.mimetype, req.file.size, req.user.id);
    res.status(201).json(one(+req.params.id, req.user));
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
  res.json(one(a.report_id, req.user));
});

/* Persons of interest are tags in the "Person" category with a profile, so name and alias mentions link reports automatically.
   Redacting a file hides the person and their tag from ordinary use without ever touching poi_revisions' permanent history. */
// A file's clearance works exactly like a report's (server-wide default MAX_CLEARANCE, above):
// below it, the description and aliases don't come back at all — only that the file exists.
app.get('/api/pois', need(), (req, res) => {
  const showRedacted = req.query.deleted === '1' && req.user.role === 'warden';
  const rows = db.prepare(`SELECT t.id, t.name, COALESCE(p.description,'') AS description, COALESCE(p.aliases,'') AS aliases, p.deleted_at,
    COALESCE(p.clearance, ${MAX_CLEARANCE}) AS clearance, COUNT(r.id) AS n
    FROM tags t JOIN categories c ON c.id = t.category_id AND c.name = 'Person' LEFT JOIN poi_profiles p ON p.tag_id = t.id
    LEFT JOIN report_tags rt ON rt.tag_id = t.id LEFT JOIN reports r ON r.id = rt.report_id AND r.deleted_at IS NULL
    ${showRedacted ? '' : 'WHERE p.deleted_at IS NULL'} GROUP BY t.id ORDER BY n DESC, t.name`).all();
  const full = (p) => req.user.role === 'warden' || (req.user.clearance || 0) >= p.clearance;
  // Below clearance: the name and report count still show (so two agents don't separately file
  // on the same person without knowing it), but the level itself is never handed over — same as
  // a locked report, all a viewer gets is that they aren't cleared, not what would clear them.
  res.json(rows.map((p) => {
    if (full(p)) return p;
    const { clearance, ...rest } = p;
    return { ...rest, description: '', aliases: '', scrambled: true };
  }));
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
  // A file always starts at the highest (Warden-only) clearance, same as an agent's report filing —
  // a Warden may choose a lower one right away, or loosen it later via the clearance route below.
  const reqClearance = parseInt(req.body?.clearance, 10);
  const clearance = req.user.role === 'warden' && Number.isInteger(reqClearance)
    ? Math.max(0, Math.min(MAX_CLEARANCE, reqClearance)) : MAX_CLEARANCE;
  const id = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO categories(name) VALUES('Person')").run();
    const cid = db.prepare("SELECT id FROM categories WHERE name = 'Person'").get().id;
    db.prepare('INSERT OR IGNORE INTO tags(category_id, name) VALUES(?,?)').run(cid, n);
    const tid = db.prepare('SELECT id FROM tags WHERE category_id = ? AND name = ?').get(cid, n).id;
    savePoi(tid, req.body, req.user.id);
    db.prepare('UPDATE poi_profiles SET clearance = ? WHERE tag_id = ?').run(clearance, tid);
    return tid;
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
// Same escape hatch as a report's purge, above — only once redacted, only a Warden. It deliberately
// leaves the underlying tag (and any historical report tagging) alone: the name persists as a bare,
// profile-less tag, since untagging old reports as a side effect would rewrite their history.
app.delete('/api/pois/:id/purge', need('warden'), (req, res) => {
  const tagId = +req.params.id;
  const p = db.prepare('SELECT deleted_at FROM poi_profiles WHERE tag_id = ?').get(tagId);
  if (!p?.deleted_at) return res.status(400).json({ error: 'Redact it first — only a redacted file can be purged' });
  // A full purge means fully gone: unlike a redact, this also drops the underlying tag and untags
  // every report that carried it — otherwise the file lingers forever as an undeletable tag row,
  // visible in every tag picker with nothing behind it. The name is freed for reuse afterward,
  // same as any other tag deletion (see DELETE /api/tags/:id) — posting it again starts a fresh file.
  hardDelete(['poirev_no_del'], () => {
    cascadeDelete('tags', tagId); // every row anywhere that points at this tag — see db.js
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
  });
  res.json({ ok: true });
});
app.patch('/api/pois/:id/clearance', need('warden'), (req, res) => {
  const clearance = parseInt(req.body?.clearance, 10);
  if (!Number.isInteger(clearance) || clearance < 0 || clearance > MAX_CLEARANCE) return res.status(400).json({ error: `Clearance must be 0-${MAX_CLEARANCE}` });
  const tagId = +req.params.id;
  if (!db.prepare('SELECT 1 FROM tags WHERE id = ?').get(tagId)) return res.status(404).json({ error: 'Not found' });
  db.prepare(`INSERT INTO poi_profiles(tag_id, description, aliases, clearance) VALUES(?, '', '', ?)
    ON CONFLICT(tag_id) DO UPDATE SET clearance = excluded.clearance`).run(tagId, clearance);
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
  res.json(hydrate(rows, req.user));
});

app.get('/api/reports/:id', need(), (req, res) => {
  const r = hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(+req.params.id), req.user)[0];
  if (!r || (r.deleted_at && req.user.role !== 'warden')) return res.status(404).json({ error: 'Not found' });
  if (!r.scrambled) db.prepare('INSERT OR IGNORE INTO report_reads(user_id, report_id) VALUES(?,?)').run(req.user.id, r.id);
  res.json({ ...r, unread: false });
});

// A lightweight companion to GET /api/reports/:id — the report list already carries full content
// for anything a viewer is cleared to read, so the frontend doesn't need to refetch it just to clear
// the unread dot when a card is opened; this just records that they've now seen it.
app.post('/api/reports/:id/read', need(), exists, (req, res) => {
  if (cleared(+req.params.id, req.user)) db.prepare('INSERT OR IGNORE INTO report_reads(user_id, report_id) VALUES(?,?)').run(req.user.id, +req.params.id);
  res.json({ ok: true });
});
app.post('/api/reports/:id/redact', need('warden'), (req, res) => { // soft delete — Warden only, an author can no longer redact their own report
  const r = db.prepare('SELECT 1 FROM reports WHERE id = ?').get(+req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE reports SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL").run(req.user.id, +req.params.id);
  res.json({ ok: true });
});
app.post('/api/reports/:id/restore', need('warden'), (req, res) => {
  db.prepare('UPDATE reports SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});
// A Warden may raise or lower a report's clearance at any time, independent of who filed it —
// this is how a report an agent locked to Warden-only (the filing default, above) gets shared
// more broadly, or how a Warden tightens one back down.
app.patch('/api/reports/:id/clearance', need('warden'), exists, (req, res) => {
  const clearance = parseInt(req.body?.clearance, 10);
  if (!Number.isInteger(clearance) || clearance < 0 || clearance > MAX_CLEARANCE) return res.status(400).json({ error: `Clearance must be 0-${MAX_CLEARANCE}` });
  db.prepare('UPDATE reports SET clearance = ? WHERE id = ?').run(clearance, +req.params.id);
  res.json(one(+req.params.id, req.user));
});
// The one genuine, irreversible delete in the app — everything else is soft. Only a Warden, and
// only once a report is already redacted: this is the deliberate "actually gone" step after
// redaction, for something that genuinely shouldn't be recoverable (an accident, a compromised
// cover, a legal request). It also removes the file's own search-index rows directly, since FTS5
// external-content tables don't get cleaned up by the DELETE trigger that only fires on insert.
app.delete('/api/reports/:id/purge', need('warden'), exists, (req, res) => {
  const id = +req.params.id;
  const r = db.prepare('SELECT deleted_at FROM reports WHERE id = ?').get(id);
  if (!r.deleted_at) return res.status(400).json({ error: 'Redact it first — only a redacted report can be purged' });
  const files = db.prepare('SELECT filename FROM attachments WHERE report_id = ?').all(id);
  const revIds = db.prepare('SELECT id FROM report_revisions WHERE report_id = ?').all(id).map((x) => x.id);
  const addIds = db.prepare('SELECT id FROM addenda WHERE report_id = ?').all(id).map((x) => x.id);
  hardDelete(['reports_no_delete', 'rev_no_del', 'add_no_del', 'attach_no_del'], () => {
    db.prepare('DELETE FROM reports_fts WHERE rowid = ?').run(id);
    for (const rid of revIds) db.prepare('DELETE FROM rev_fts WHERE rowid = ?').run(rid);
    for (const aid of addIds) db.prepare('DELETE FROM add_fts WHERE rowid = ?').run(aid);
    cascadeDelete('reports', id); // every row anywhere that points at this report — see db.js
    db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  });
  for (const f of files) fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {}); // best-effort; a missing file is not an error here
  res.json({ ok: true });
});

/* ---------- individual access grants: a Warden can hand one specific report to one specific
   person, on top of (or below) their standing clearance level ---------- */
app.get('/api/reports/:id/grants', need('warden'), exists, (req, res) =>
  res.json(db.prepare('SELECT g.user_id, u.callsign FROM access_grants g JOIN users u ON u.id = g.user_id WHERE g.report_id = ? ORDER BY u.callsign').all(+req.params.id)));
app.post('/api/reports/:id/grants', need('warden'), exists, (req, res) => {
  const uid = +req.body?.userId;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) return res.status(400).json({ error: 'No such user' });
  db.prepare('INSERT OR IGNORE INTO access_grants(report_id, user_id, granted_by) VALUES(?,?,?)').run(+req.params.id, uid, req.user.id);
  res.status(201).json({ ok: true });
});
app.delete('/api/reports/:id/grants/:userId', need('warden'), (req, res) => {
  db.prepare('DELETE FROM access_grants WHERE report_id = ? AND user_id = ?').run(+req.params.id, +req.params.userId);
  res.json({ ok: true });
});

/* ---------- faction rosters: a plain, directly-editable list of members and rank, kept current by
   whoever's watching that faction — unlike a report, there's no permanent history here. A faction
   also carries its own clearance, same mechanism as a report: below it, the roster and notes don't
   come back at all, only that the faction exists. New factions default to clearance 0 (visible to
   everyone) — a faction is reference material, not a compartmented case file, unless a Warden
   deliberately raises one. ---------- */
const factionCleared = (id, viewer) => {
  const f = db.prepare('SELECT clearance FROM factions WHERE id = ?').get(id);
  return !f || viewer.role === 'warden' || (viewer.clearance || 0) >= f.clearance;
};
const factionExists = (req, res, next) => (db.prepare('SELECT 1 FROM factions WHERE id = ?').get(+req.params.id) ? next() : res.status(404).json({ error: 'Not found' }));
app.get('/api/factions', need(), (req, res) => {
  const factions = db.prepare('SELECT id, name, notes, created_at, clearance FROM factions ORDER BY name').all();
  const members = db.prepare(`SELECT m.id, m.faction_id, m.name, m.rank, m.notes, m.updated_at, u.callsign AS updated_by
    FROM faction_members m JOIN users u ON u.id = m.updated_by ORDER BY m.name`).all();
  const full = (f) => req.user.role === 'warden' || (req.user.clearance || 0) >= f.clearance;
  // Same rule as a locked report or file: the faction's name still shows, but a viewer who isn't
  // cleared for its roster is never told the level that would clear them, only that they lack it.
  res.json(factions.map((f) => {
    if (full(f)) return { ...f, members: members.filter((m) => m.faction_id === f.id) };
    const { clearance, ...rest } = f;
    return { ...rest, notes: '', members: [], scrambled: true };
  }));
});
app.post('/api/factions', need(), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'A name is required' });
  try {
    const id = db.prepare('INSERT INTO factions(name, notes) VALUES(?,?)').run(name, String(req.body?.notes || '').slice(0, 2000)).lastInsertRowid;
    res.status(201).json({ id });
  } catch { res.status(409).json({ error: 'A faction with that name already exists' }); }
});
app.put('/api/factions/:id', need(), factionExists, (req, res) => {
  if (!factionCleared(+req.params.id, req.user)) return res.status(403).json({ error: 'You are not cleared to read this faction' });
  db.prepare('UPDATE factions SET notes = ? WHERE id = ?').run(String(req.body?.notes || '').slice(0, 2000), +req.params.id);
  res.json({ ok: true });
});
app.patch('/api/factions/:id/clearance', need('warden'), factionExists, (req, res) => {
  const clearance = parseInt(req.body?.clearance, 10);
  if (!Number.isInteger(clearance) || clearance < 0 || clearance > MAX_CLEARANCE) return res.status(400).json({ error: `Clearance must be 0-${MAX_CLEARANCE}` });
  db.prepare('UPDATE factions SET clearance = ? WHERE id = ?').run(clearance, +req.params.id);
  res.json({ ok: true });
});
app.delete('/api/factions/:id', need('warden'), (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM faction_members WHERE faction_id = ?').run(+req.params.id);
    db.prepare('DELETE FROM factions WHERE id = ?').run(+req.params.id);
  })();
  res.json({ ok: true });
});
app.post('/api/factions/:id/members', need(), factionExists, (req, res) => {
  if (!factionCleared(+req.params.id, req.user)) return res.status(403).json({ error: 'You are not cleared to read this faction' });
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'A name is required' });
  const id = db.prepare('INSERT INTO faction_members(faction_id, name, rank, notes, updated_by) VALUES(?,?,?,?,?)')
    .run(+req.params.id, name, String(b.rank || '').slice(0, 60), String(b.notes || '').slice(0, 2000), req.user.id).lastInsertRowid;
  res.status(201).json({ id });
});
app.put('/api/faction-members/:id', need(), (req, res) => {
  const m = db.prepare('SELECT faction_id FROM faction_members WHERE id = ?').get(+req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!factionCleared(m.faction_id, req.user)) return res.status(403).json({ error: 'You are not cleared to read this faction' });
  const b = req.body || {};
  db.prepare('UPDATE faction_members SET name = ?, rank = ?, notes = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .run(String(b.name || '').trim().slice(0, 80), String(b.rank || '').slice(0, 60), String(b.notes || '').slice(0, 2000), req.user.id, new Date().toISOString(), +req.params.id);
  res.json({ ok: true });
});
app.delete('/api/faction-members/:id', need(), (req, res) => {
  const m = db.prepare('SELECT faction_id FROM faction_members WHERE id = ?').get(+req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!factionCleared(m.faction_id, req.user)) return res.status(403).json({ error: 'You are not cleared to read this faction' });
  db.prepare('DELETE FROM faction_members WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

/* ---------- Warden <-> member notes: a private, anonymous 1:1 thread per agent. A Warden can open
   a chat with any agent from a list; the agent sees only that "The Wardens" sent something, never
   which one — the API below never returns author_id, or who wrote a 'warden' message, to anyone.
   A thread only ever gets created by a Warden's first message (POST /api/notes/threads/:userId) —
   a member can never start one themselves, so the Notes tab stays hidden to them (see /api/notes/status)
   until a Warden reaches out. hidden lets a Warden pull a thread out of a member's Archive entirely,
   invisibly, without touching a single row; deleted_at/edited_at on a message let a Warden delete or
   rewrite one line the same way — GET /api/notes/mine below is what actually keeps both invisible to
   the member, a Warden's own view (GET /api/notes/threads/:userId) always sees the true state. */
app.get('/api/notes/threads', need('warden'), (_req, res) => {
  res.json(db.prepare(`
    SELECT u.id AS user_id, u.callsign, t.id AS thread_id, COALESCE(t.hidden, 0) AS hidden,
      (SELECT COUNT(*) FROM notes_messages nm WHERE nm.thread_id = t.id AND nm.sender = 'member' AND nm.read_at IS NULL AND nm.deleted_at IS NULL) AS unread,
      (SELECT nm.created_at FROM notes_messages nm WHERE nm.thread_id = t.id AND nm.deleted_at IS NULL ORDER BY nm.id DESC LIMIT 1) AS last_at
    FROM users u LEFT JOIN notes_threads t ON t.member_id = u.id
    WHERE u.role = 'agent' ORDER BY (last_at IS NULL), last_at DESC, u.callsign`).all());
});
app.get('/api/notes/threads/:userId', need('warden'), (req, res) => {
  const uid = +req.params.userId;
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'agent'").get(uid)) return res.status(404).json({ error: 'Not found' });
  const t = db.prepare('SELECT id, hidden FROM notes_threads WHERE member_id = ?').get(uid);
  if (!t) return res.json({ hidden: false, messages: [] });
  db.prepare("UPDATE notes_messages SET read_at = ? WHERE thread_id = ? AND sender = 'member' AND read_at IS NULL").run(new Date().toISOString(), t.id);
  const messages = db.prepare('SELECT id, sender, body, created_at, edited_at, deleted_at FROM notes_messages WHERE thread_id = ? ORDER BY id').all(t.id);
  res.json({ hidden: !!t.hidden, messages });
});
app.post('/api/notes/threads/:userId', need('warden'), (req, res) => {
  const uid = +req.params.userId;
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'agent'").get(uid)) return res.status(404).json({ error: 'Not found' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'A note needs some text' });
  const tid = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO notes_threads(member_id) VALUES(?)').run(uid);
    return db.prepare('SELECT id FROM notes_threads WHERE member_id = ?').get(uid).id;
  })();
  db.prepare("INSERT INTO notes_messages(thread_id, sender, author_id, body) VALUES(?, 'warden', ?, ?)").run(tid, req.user.id, body);
  res.status(201).json({ ok: true });
});
// Pull a thread out of the member's own Archive (or put it back) — nothing is deleted, the member's
// two routes below just stop admitting the thread exists while this is set.
app.patch('/api/notes/threads/:userId/hidden', need('warden'), (req, res) => {
  const uid = +req.params.userId, t = db.prepare('SELECT id FROM notes_threads WHERE member_id = ?').get(uid);
  if (!t) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notes_threads SET hidden = ? WHERE id = ?').run(req.body?.hidden ? 1 : 0, t.id);
  res.json({ ok: true });
});
// Edit or delete a single message, invisibly to the member — a soft delete (deleted_at) rather than
// a row removal, same "never truly gone" rule as everything else, just kept out of the member's own
// GET below rather than out of the database.
app.patch('/api/notes/threads/:userId/messages/:msgId', need('warden'), (req, res) => {
  const uid = +req.params.userId, mid = +req.params.msgId;
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'A note needs some text' });
  const m = db.prepare(`SELECT nm.id FROM notes_messages nm JOIN notes_threads t ON t.id = nm.thread_id WHERE nm.id = ? AND t.member_id = ?`).get(mid, uid);
  if (!m) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notes_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, new Date().toISOString(), mid);
  res.json({ ok: true });
});
app.delete('/api/notes/threads/:userId/messages/:msgId', need('warden'), (req, res) => {
  const uid = +req.params.userId, mid = +req.params.msgId;
  const m = db.prepare(`SELECT nm.id FROM notes_messages nm JOIN notes_threads t ON t.id = nm.thread_id WHERE nm.id = ? AND t.member_id = ?`).get(mid, uid);
  if (!m) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notes_messages SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), mid);
  res.json({ ok: true });
});
// Undo an accidental delete — same "nothing is really gone" rule the rest of the app follows
// (a redacted report or file can be restored the same way). Still invisible to the member either way.
app.post('/api/notes/threads/:userId/messages/:msgId/restore', need('warden'), (req, res) => {
  const uid = +req.params.userId, mid = +req.params.msgId;
  const m = db.prepare(`SELECT nm.id FROM notes_messages nm JOIN notes_threads t ON t.id = nm.thread_id WHERE nm.id = ? AND t.member_id = ?`).get(mid, uid);
  if (!m) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notes_messages SET deleted_at = NULL WHERE id = ?').run(mid);
  res.json({ ok: true });
});
// The member's own side of the same thread — they see the Warden's messages, but sender is always
// just 'warden', never who; a hidden thread or a deleted message simply isn't in this response at all.
app.get('/api/notes/mine', need(), (req, res) => {
  if (req.user.role === 'warden') return res.status(400).json({ error: 'Wardens use /api/notes/threads' });
  const t = db.prepare('SELECT id FROM notes_threads WHERE member_id = ? AND hidden = 0').get(req.user.id);
  if (!t) return res.json([]);
  db.prepare("UPDATE notes_messages SET read_at = ? WHERE thread_id = ? AND sender = 'warden' AND read_at IS NULL AND deleted_at IS NULL").run(new Date().toISOString(), t.id);
  res.json(db.prepare('SELECT id, sender, body, created_at FROM notes_messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id').all(t.id));
});
app.post('/api/notes/mine', need(), (req, res) => {
  if (req.user.role === 'warden') return res.status(400).json({ error: 'Wardens use /api/notes/threads' });
  // A member never starts a thread — only a Warden's first message does (POST /api/notes/threads/:userId,
  // above) — so there's nothing to reply into until that's happened, and a hidden thread stays invisible.
  const t = db.prepare('SELECT id FROM notes_threads WHERE member_id = ? AND hidden = 0').get(req.user.id);
  if (!t) return res.status(403).json({ error: 'A Warden has not reached out to you yet' });
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'A note needs some text' });
  db.prepare("INSERT INTO notes_messages(thread_id, sender, author_id, body) VALUES(?, 'member', ?, ?)").run(t.id, req.user.id, body);
  res.status(201).json({ ok: true });
});
// Lets the member's own UI decide whether to show the Notes tab at all, and whether to draw an
// unread badge on it — without exposing message content or the thread's existence beyond that.
app.get('/api/notes/status', need(), (req, res) => {
  if (req.user.role === 'warden') return res.status(400).json({ error: 'Wardens use /api/notes/threads' });
  const t = db.prepare('SELECT id FROM notes_threads WHERE member_id = ? AND hidden = 0').get(req.user.id);
  if (!t) return res.json({ open: false, unread: 0 });
  const unread = db.prepare("SELECT COUNT(*) AS n FROM notes_messages WHERE thread_id = ? AND sender = 'warden' AND read_at IS NULL AND deleted_at IS NULL").get(t.id).n;
  res.json({ open: true, unread });
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
