import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const app = express();
const PROD = process.env.NODE_ENV === 'production';
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

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

const tries = new Map(); // crude login throttle: 8 attempts / 10 min per ip+callsign
const throttled = (k) => { const now = Date.now(), a = (tries.get(k) || []).filter((t) => now - t < 6e5); a.push(now); tries.set(k, a); return a.length > 8; };

/* ---------- auth routes ---------- */
app.post('/api/auth/signup', (req, res) => {
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
  if (throttled(req.ip + c.toLowerCase())) return res.status(429).json({ error: 'Too many attempts. Wait a while.' });
  const u = db.prepare('SELECT * FROM users WHERE callsign = ?').get(c);
  if (!u || !checkPw(p, u.pass_hash)) return res.status(401).json({ error: 'Callsign or passphrase not recognised' });
  if (u.role === 'pending') return res.status(403).json({ error: 'Awaiting the Warden' });
  startSession(res, u.id);
  res.json({ id: u.id, callsign: u.callsign, role: u.role });
});

app.post('/api/auth/logout', (req, res) => {
  const t = cookie(req, 'mf'); if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.clearCookie('mf').json({ ok: true });
});
app.get('/api/me', need(), (req, res) => res.json(req.user));

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
  const rows = db.prepare(`SELECT c.id AS cid, c.name AS category, t.id, t.name, p.aliases FROM categories c LEFT JOIN tags t ON t.category_id = c.id LEFT JOIN poi_profiles p ON p.tag_id = t.id ORDER BY c.id, t.name`).all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.cid)) out.set(r.cid, { id: r.cid, name: r.category, tags: [] });
    if (r.id) out.get(r.cid).tags.push({ id: r.id, name: r.name, aliases: r.aliases || '' });
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

/* ---------- reports ---------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesOf = (t) => [t.name, ...String(t.aliases || '').split(',').map((a) => a.trim())].filter(Boolean);
const mentions = (t, text) => namesOf(t).some((n) => new RegExp(`\\b${esc(n)}(e?s)?\\b`, 'i').test(text));
const TAGS = 'SELECT t.id, t.name, p.aliases FROM tags t LEFT JOIN poi_profiles p ON p.tag_id = t.id';
const tagText = (rid, text, manual = []) => { // tags are only ever added to a report, never removed
  const ins = db.prepare('INSERT OR IGNORE INTO report_tags(report_id, tag_id, auto) SELECT ?, id, ? FROM tags WHERE id = ?');
  db.prepare(TAGS).all().filter((t) => mentions(t, text)).forEach((t) => ins.run(rid, 1, t.id));
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
const hydrate = (rows) => { // each report comes back as a full case file: current text, history, addenda, links
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id), m = ids.map(() => '?').join(), all = (sql, ...p) => db.prepare(sql).all(...p);
  const tg = all(`SELECT rt.report_id, rt.auto, t.id, t.name, c.name AS category FROM report_tags rt JOIN tags t ON t.id = rt.tag_id JOIN categories c ON c.id = t.category_id WHERE rt.report_id IN (${m})`, ...ids);
  const rv = all(`SELECT v.id, v.report_id, v.title, v.body, v.confidence, s.name AS source, v.note, v.edited_at, u.callsign AS editor FROM report_revisions v JOIN users u ON u.id = v.edited_by LEFT JOIN sources s ON s.id = v.source_id WHERE v.report_id IN (${m}) ORDER BY v.id`, ...ids);
  const ad = all(`SELECT a.id, a.report_id, a.body, a.confidence, s.name AS source, a.created_at, u.callsign AS author FROM addenda a JOIN users u ON u.id = a.author_id LEFT JOIN sources s ON s.id = a.source_id WHERE a.report_id IN (${m}) ORDER BY a.id`, ...ids);
  const lk = all(`SELECT a, b FROM report_links WHERE a IN (${m}) OR b IN (${m})`, ...ids, ...ids);
  const lids = [...new Set(lk.flatMap((l) => [l.a, l.b]))];
  const titles = lids.length ? Object.fromEntries(all(`SELECT x.id, COALESCE((SELECT v.title FROM report_revisions v WHERE v.report_id = x.id ORDER BY v.id DESC LIMIT 1), x.title) AS title
    FROM reports x WHERE x.id IN (${lids.map(() => '?').join()})`, ...lids).map((x) => [x.id, x.title])) : {};
  return rows.map((r) => {
    const v = rv.filter((x) => x.report_id === r.id), c = v.at(-1);
    return {
      ...r, original: { title: r.title, body: r.body, confidence: r.confidence, source: r.source },
      ...(c ? { title: c.title, body: c.body, confidence: c.confidence, source: c.source } : {}),
      tags: tg.filter((x) => x.report_id === r.id), revisions: [...v].reverse(), addenda: ad.filter((x) => x.report_id === r.id),
      links: lk.filter((l) => l.a === r.id || l.b === r.id).map((l) => { const o = l.a === r.id ? l.b : l.a; return { id: o, title: titles[o] }; }),
    };
  });
};
const one = (id) => hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(id))[0];
const exists = (req, res, next) => (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(+req.params.id) ? next() : res.status(404).json({ error: 'Not found' }));

app.post('/api/reports', need(), (req, res) => {
  const title = String(req.body?.title || '').trim(), body = String(req.body?.body || '');
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
  res.status(201).json(one(id));
});

/* Any agent may amend a report. The original and every revision are kept forever; the latest one is what is shown. */
app.post('/api/reports/:id/edit', need(), exists, (req, res) => {
  const id = +req.params.id, cur = one(id), b = req.body || {};
  const title = String(b.title ?? cur.title).trim(), body = String(b.body ?? cur.body);
  if (!title || !body.trim()) return res.status(400).json({ error: 'Title and body required' });
  db.transaction(() => {
    db.prepare('INSERT INTO report_revisions(report_id, title, body, confidence, source_id, note, edited_by) VALUES(?,?,?,?,?,?,?)')
      .run(id, title, body, conf(b.confidence), srcId(b.source), String(b.note || '').slice(0, 200), req.user.id);
    tagText(id, title + ' ' + body);
  })();
  res.json(one(id));
});
app.post('/api/reports/:id/addenda', need(), exists, (req, res) => { // later information, possibly from another source
  const id = +req.params.id, body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Addendum is empty' });
  db.transaction(() => {
    db.prepare('INSERT INTO addenda(report_id, body, confidence, source_id, author_id) VALUES(?,?,?,?,?)').run(id, body, conf(req.body.confidence), srcId(req.body.source), req.user.id);
    tagText(id, body);
  })();
  res.status(201).json(one(id));
});
app.post('/api/reports/:id/links', need(), exists, (req, res) => {
  const a = +req.params.id, b = +req.body?.toId;
  if (!b || a === b || !db.prepare('SELECT 1 FROM reports WHERE id = ?').get(b)) return res.status(400).json({ error: 'Pick another report' });
  db.prepare('INSERT OR IGNORE INTO report_links(a, b, linked_by) VALUES(?,?,?)').run(Math.min(a, b), Math.max(a, b), req.user.id);
  res.json(one(a));
});
app.get('/api/sources', need(), (_req, res) => res.json(db.prepare('SELECT name FROM sources ORDER BY name').all().map((x) => x.name)));

/* Persons of interest are tags in the "Person" category with a profile, so name and alias mentions link reports automatically. */
app.get('/api/pois', need(), (_req, res) => res.json(db.prepare(`SELECT t.id, t.name, COALESCE(p.description,'') AS description, COALESCE(p.aliases,'') AS aliases, COUNT(r.id) AS n
  FROM tags t JOIN categories c ON c.id = t.category_id AND c.name = 'Person' LEFT JOIN poi_profiles p ON p.tag_id = t.id
  LEFT JOIN report_tags rt ON rt.tag_id = t.id LEFT JOIN reports r ON r.id = rt.report_id AND r.deleted_at IS NULL GROUP BY t.id ORDER BY n DESC, t.name`).all()));
const savePoi = (tagId, b) => {
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
    savePoi(tid, req.body); return tid;
  })();
  res.status(201).json({ id });
});
app.put('/api/pois/:id', need(), (req, res) => { savePoi(+req.params.id, req.body || {}); res.json({ ok: true }); });

app.get('/api/reports', need(), (req, res) => {
  const { q, tags, deleted, limit, offset } = req.query, w = [], a = [];
  if (!(deleted === '1' && req.user.role === 'warden')) w.push('r.deleted_at IS NULL');
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu);
  if (words) { // searches originals, every revision and every addendum
    const f = words.map((t) => `"${t}"*`).join(' ');
    w.push(`(r.id IN (SELECT rowid FROM reports_fts WHERE reports_fts MATCH ?) OR r.id IN (SELECT report_id FROM report_revisions WHERE id IN (SELECT rowid FROM rev_fts WHERE rev_fts MATCH ?))
      OR r.id IN (SELECT report_id FROM addenda WHERE id IN (SELECT rowid FROM add_fts WHERE add_fts MATCH ?)))`);
    a.push(f, f, f);
  }
  for (const t of String(tags || '').split(',').filter(Boolean)) { w.push('r.id IN (SELECT report_id FROM report_tags WHERE tag_id = ?)'); a.push(+t); }
  const rows = db.prepare(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`)
    .all(...a, Math.min(+limit || 50, 200), +offset || 0);
  res.json(hydrate(rows));
});

app.get('/api/reports/:id', need(), (req, res) => {
  const r = hydrate(db.prepare(`${SELECT} WHERE r.id = ?`).all(+req.params.id))[0];
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
const THEMES = ['nocturne', 'parchment', 'stormcloak', 'thalmor'], FONTS = ['ledger', 'typewriter', 'clean'];
app.get('/api/settings', need(), (req, res) => {
  const r = db.prepare('SELECT json FROM user_settings WHERE user_id = ?').get(req.user.id);
  res.json({ theme: 'nocturne', font: 'ledger', ...(r ? JSON.parse(r.json) : {}) });
});
app.put('/api/settings', need(), (req, res) => {
  const { theme, font } = req.body || {};
  if (!THEMES.includes(theme) || !FONTS.includes(font)) return res.status(400).json({ error: 'Unknown theme or font' });
  db.prepare('INSERT INTO user_settings(user_id, json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json').run(req.user.id, JSON.stringify({ theme, font }));
  res.json({ theme, font });
});

/* ---------- stats for dashboard ---------- */
app.get('/api/stats/heatmap', need(), (_req, res) => // day buckets in Skyrim time (UTC-5)
  res.json(db.prepare(`SELECT date(created_at, '-5 hours') AS day, COUNT(*) AS n FROM reports
    WHERE deleted_at IS NULL AND created_at >= date('now', '-380 days') GROUP BY day`).all()));
app.get('/api/stats/tags', need(), (_req, res) => // counts per tag: powers the map pins
  res.json(db.prepare(`SELECT t.id, t.name, c.name AS category, COUNT(r.id) AS n FROM tags t
    JOIN categories c ON c.id = t.category_id LEFT JOIN report_tags rt ON rt.tag_id = t.id
    LEFT JOIN reports r ON r.id = rt.report_id AND r.deleted_at IS NULL GROUP BY t.id`).all()));

/* ---------- serve the built React app ---------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'No such route' }));
app.use(express.static(DIST));
app.use((_req, res) => res.sendFile(path.join(DIST, 'index.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Manifesto listening on :${port}`));
