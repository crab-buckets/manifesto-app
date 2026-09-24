import Database from 'better-sqlite3';

export const db = new Database(process.env.DB_PATH || './manifesto.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"; // always UTC; Skyrim time (UTC-5) is applied on read

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  callsign TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'pending' CHECK(role IN ('warden','agent','pending')),
  created_at TEXT NOT NULL DEFAULT (${NOW}));

CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS tags(
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE(category_id, name));

CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  filed_at TEXT NOT NULL DEFAULT (${NOW}),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id));

CREATE TABLE IF NOT EXISTS report_tags(
  report_id INTEGER NOT NULL REFERENCES reports(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  auto INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(report_id, tag_id));

CREATE TABLE IF NOT EXISTS user_settings(user_id INTEGER PRIMARY KEY REFERENCES users(id), json TEXT NOT NULL);

CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(title, body, content='reports', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS reports_ai AFTER INSERT ON reports BEGIN
  INSERT INTO reports_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;

-- The database itself refuses to lose or rewrite a report. Only deleted_at/deleted_by may change.
CREATE TRIGGER IF NOT EXISTS reports_no_delete BEFORE DELETE ON reports
  BEGIN SELECT RAISE(ABORT, 'reports are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS reports_immutable BEFORE UPDATE OF title, body, author_id, created_at ON reports
  BEGIN SELECT RAISE(ABORT, 'report content is immutable'); END;
`);

// Upgrade an existing database: created_at is now the EVENT time, filed_at is when it was lodged.
if (!db.prepare("SELECT 1 FROM pragma_table_info('reports') WHERE name='filed_at'").get()) {
  db.exec('ALTER TABLE reports ADD COLUMN filed_at TEXT; UPDATE reports SET filed_at = created_at;');
}

// ---- case-file features: sources, revisions, addenda, links, persons of interest ----
db.exec(`
CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS report_revisions(
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id),
  title TEXT NOT NULL, body TEXT NOT NULL, confidence TEXT, source_id INTEGER REFERENCES sources(id), note TEXT,
  edited_by INTEGER NOT NULL REFERENCES users(id), edited_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS addenda(
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id), body TEXT NOT NULL, confidence TEXT,
  source_id INTEGER REFERENCES sources(id), author_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS report_links(
  a INTEGER NOT NULL REFERENCES reports(id), b INTEGER NOT NULL REFERENCES reports(id),
  linked_by INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(a, b), CHECK(a < b));
CREATE TABLE IF NOT EXISTS poi_revisions(
  id INTEGER PRIMARY KEY, tag_id INTEGER NOT NULL REFERENCES tags(id), description TEXT NOT NULL, aliases TEXT NOT NULL,
  edited_by INTEGER NOT NULL REFERENCES users(id), edited_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TRIGGER IF NOT EXISTS poirev_no_upd BEFORE UPDATE ON poi_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
CREATE TRIGGER IF NOT EXISTS poirev_no_del BEFORE DELETE ON poi_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
CREATE TABLE IF NOT EXISTS poi_profiles(
  tag_id INTEGER PRIMARY KEY REFERENCES tags(id), description TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '');

CREATE VIRTUAL TABLE IF NOT EXISTS rev_fts USING fts5(title, body, content='report_revisions', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS add_fts USING fts5(body, content='addenda', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS rev_ai AFTER INSERT ON report_revisions BEGIN INSERT INTO rev_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
CREATE TRIGGER IF NOT EXISTS add_ai AFTER INSERT ON addenda BEGIN INSERT INTO add_fts(rowid, body) VALUES (new.id, new.body); END;
-- Edit history and addenda are append-only: the database refuses to alter or remove them.
CREATE TRIGGER IF NOT EXISTS rev_no_upd BEFORE UPDATE ON report_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
CREATE TRIGGER IF NOT EXISTS rev_no_del BEFORE DELETE ON report_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END;
CREATE TRIGGER IF NOT EXISTS add_no_upd BEFORE UPDATE ON addenda BEGIN SELECT RAISE(ABORT, 'addenda are permanent'); END;
CREATE TRIGGER IF NOT EXISTS add_no_del BEFORE DELETE ON addenda BEGIN SELECT RAISE(ABORT, 'addenda are permanent'); END;
`);
for (const [col, ddl] of [['confidence', 'TEXT'], ['source_id', 'INTEGER REFERENCES sources(id)']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('reports') WHERE name = ?").get(col)) db.exec(`ALTER TABLE reports ADD COLUMN ${col} ${ddl}`);
}

// ---- attachments: files clipped to a report's case file ----
db.exec(`
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id),
  filename TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TRIGGER IF NOT EXISTS attach_no_del BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'attachments are permanent'); END;
`);
// The file itself is still never deleted from the database — only deleted_at/deleted_by (soft removal, same
// as reports) may change on an attachment row. Drop the old blanket no-update trigger in favour of a narrower one.
for (const [col, ddl] of [['deleted_at', 'TEXT'], ['deleted_by', 'INTEGER REFERENCES users(id)']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('attachments') WHERE name = ?").get(col)) db.exec(`ALTER TABLE attachments ADD COLUMN ${col} ${ddl}`);
}
db.exec(`
DROP TRIGGER IF EXISTS attach_no_upd;
CREATE TRIGGER IF NOT EXISTS attach_immutable BEFORE UPDATE OF filename, original_name, mime, size, report_id, uploaded_by, created_at ON attachments
  BEGIN SELECT RAISE(ABORT, 'attachments are permanent'); END;
`);

// A Person-of-interest file can be redacted (hiding it and its tag from ordinary use) without ever
// losing the permanent poi_revisions history — same soft-delete pattern as reports.
for (const [col, ddl] of [['deleted_at', 'TEXT'], ['deleted_by', 'INTEGER REFERENCES users(id)']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('poi_profiles') WHERE name = ?").get(col)) db.exec(`ALTER TABLE poi_profiles ADD COLUMN ${col} ${ddl}`);
}

// ---- indexes: the lookups the app actually runs, so they stay fast as reports pile up ----
db.exec(`
CREATE INDEX IF NOT EXISTS idx_reports_deleted_created ON reports(deleted_at, created_at);
CREATE INDEX IF NOT EXISTS idx_report_tags_tag ON report_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_revisions_report ON report_revisions(report_id);
CREATE INDEX IF NOT EXISTS idx_links_a ON report_links(a);
CREATE INDEX IF NOT EXISTS idx_links_b ON report_links(b);
CREATE INDEX IF NOT EXISTS idx_attachments_report ON attachments(report_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category_id);
`);

const DEFAULTS = {
  Hold: ['Dawnstar', 'Riften', 'Whiterun', 'Solitude', 'Windhelm', 'Markarth', 'Winterhold', 'Falkreath', 'Morthal'],
  Faction: ['Dawnguard', 'Stormcloak', 'Imperial', 'Thalmor', 'Thieves Guild', 'Dark Brotherhood', 'Companions', 'Blades'],
  Supernatural: ['Vampire', 'Werewolf', 'Cult', 'Daedra', 'Necromancer', 'Dragon'],
};
if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
  db.transaction(() => {
    for (const [cat, names] of Object.entries(DEFAULTS)) {
      const id = db.prepare('INSERT INTO categories(name) VALUES(?)').run(cat).lastInsertRowid;
      for (const n of names) db.prepare('INSERT INTO tags(category_id,name) VALUES(?,?)').run(id, n);
    }
  })();
}
