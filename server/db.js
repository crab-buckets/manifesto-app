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

// ---- case-file features: sources, revisions, addenda, persons of interest ----
db.exec(`
CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS report_revisions(
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id),
  title TEXT NOT NULL, body TEXT NOT NULL, confidence TEXT, source_id INTEGER REFERENCES sources(id), note TEXT,
  edited_by INTEGER NOT NULL REFERENCES users(id), edited_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS addenda(
  id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES reports(id), body TEXT NOT NULL, confidence TEXT,
  source_id INTEGER REFERENCES sources(id), author_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (${NOW}));
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

// ---- clearance levels, cover names & per-report access grants ----
// Everyone can see that a report exists; whether they see its real text depends on their numeric
// clearance level (>= the report's own), an individual grant a Warden handed them, or having
// written it themselves. Below all three, the record is scrambled at read time (see server/index.js).
for (const [col, ddl] of [['clearance', 'INTEGER NOT NULL DEFAULT 0'], ['cover_name', 'TEXT']]) {
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${ddl}`);
}
if (!db.prepare("SELECT 1 FROM pragma_table_info('reports') WHERE name = 'clearance'").get()) {
  db.exec('ALTER TABLE reports ADD COLUMN clearance INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
CREATE TABLE IF NOT EXISTS access_grants(
  report_id INTEGER NOT NULL REFERENCES reports(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  granted_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY(report_id, user_id));
CREATE INDEX IF NOT EXISTS idx_grants_user ON access_grants(user_id);

-- ---- faction rosters: who's in a faction and their rank, kept up to date by whoever's watching
-- them. Deliberately NOT the immutable revision-history pattern reports use above — a roster is a
-- living document that gets corrected in place, not a permanent case file.
CREATE TABLE IF NOT EXISTS factions(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS faction_members(
  id INTEGER PRIMARY KEY,
  faction_id INTEGER NOT NULL REFERENCES factions(id),
  name TEXT NOT NULL,
  rank TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_by INTEGER NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE INDEX IF NOT EXISTS idx_faction_members_faction ON faction_members(faction_id);
`);

// The field-messages feature (a Warden leaving a note at a Hold for a specific informant) was
// removed. A database that already created the table keeps it, harmlessly unused — dropping it
// isn't worth the risk to a table that isn't referenced anywhere any more.

// Report linking (marking two reports as related to each other) was removed the same way — an
// existing database keeps the now-unused report_links table rather than risk a DROP.

// ---- faction clearance: a faction's roster is gated exactly like a report's body (server/index.js) ----
if (!db.prepare("SELECT 1 FROM pragma_table_info('factions') WHERE name = 'clearance'").get()) {
  db.exec('ALTER TABLE factions ADD COLUMN clearance INTEGER NOT NULL DEFAULT 0');
}

// ---- persons of interest: same treatment as a report — filed at the highest (Warden-only)
// clearance by default, a Warden can lower it afterward. MAX_CLEARANCE is 5 in server/index.js;
// duplicated here as a literal the same way that file already duplicates it from views.jsx.
if (!db.prepare("SELECT 1 FROM pragma_table_info('poi_profiles') WHERE name = 'clearance'").get()) {
  db.exec('ALTER TABLE poi_profiles ADD COLUMN clearance INTEGER NOT NULL DEFAULT 5');
}

// ---- hard delete: a deliberate, narrow escape hatch from the append-only guarantees above ----
// Used only once an item is already redacted, and only by a Warden (server/index.js enforces both).
// It transiently drops the named BEFORE DELETE guard triggers, runs the deletes, and puts the exact
// same triggers straight back before the transaction commits — so the guarantee still holds for
// every other codepath, including a crash mid-purge (SQLite rolls the whole transaction back).
const DELETE_GUARDS = {
  reports_no_delete: "CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT, 'reports are never deleted'); END",
  rev_no_del: "CREATE TRIGGER rev_no_del BEFORE DELETE ON report_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END",
  add_no_del: "CREATE TRIGGER add_no_del BEFORE DELETE ON addenda BEGIN SELECT RAISE(ABORT, 'addenda are permanent'); END",
  attach_no_del: "CREATE TRIGGER attach_no_del BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'attachments are permanent'); END",
  poirev_no_del: "CREATE TRIGGER poirev_no_del BEFORE DELETE ON poi_revisions BEGIN SELECT RAISE(ABORT, 'history is permanent'); END",
};
export const hardDelete = (guards, fn) => db.transaction(() => {
  for (const g of guards) db.exec(`DROP TRIGGER IF EXISTS ${g}`);
  try { return fn(); } finally { for (const g of guards) db.exec(DELETE_GUARDS[g]); }
})();

// A purge route used to hand-list every table that could hold a row pointing at the thing being
// removed, and it's easy to add a new referencing table later (or forget one that's already
// there) without updating that list — exactly what caused a "FOREIGN KEY constraint failed" on
// deleting a report that still had rows elsewhere quietly pointing at it. This asks SQLite's own
// schema what actually references `table`, via pragma_foreign_key_list, and deletes every row
// that does — so a purge can never again be missing a table it should have cleaned up first.
export const cascadeDelete = (table, id) => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != ?").all(table).map((r) => r.name);
  for (const t of tables) {
    const fks = db.prepare('SELECT "table" AS ref_table, "from" AS ref_col FROM pragma_foreign_key_list(?)').all(t);
    for (const fk of fks) {
      if (fk.ref_table === table) db.prepare(`DELETE FROM "${t}" WHERE "${fk.ref_col}" = ?`).run(id);
    }
  }
};

// ---- anonymous Warden <-> member notes: a private thread per agent. A Warden's message is shown
// to the member as coming from "The Wardens" collectively, never a specific person — author_id is
// kept for the record but the API (server/index.js) never returns it for a Warden-sent message.
// member_id/author_id are nullable: removing a user (DELETE /api/users/:id) never has to touch
// this table, it just clears the pointer and leaves member_label as a snapshot of who it was, so
// the thread and every message in it survive a fully-removed account intact. hidden lets a Warden
// pull the whole thread out of a member's Archive without deleting anything; deleted_at/edited_at
// on a message let a Warden delete or rewrite a single line with nothing shown to the member —
// GET /api/notes/mine (server/index.js) is what actually keeps both invisible to them. ----
db.exec(`
CREATE TABLE IF NOT EXISTS notes_threads(
  id INTEGER PRIMARY KEY,
  member_id INTEGER UNIQUE REFERENCES users(id),
  member_label TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS notes_messages(
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES notes_threads(id),
  sender TEXT NOT NULL CHECK(sender IN ('warden', 'member')),
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  edited_at TEXT,
  deleted_at TEXT,
  read_at TEXT);
CREATE INDEX IF NOT EXISTS idx_notes_messages_thread ON notes_messages(thread_id, id);
`);
// Migrate a database from before member_id/author_id were relaxed to nullable — SQLite can't drop
// a NOT NULL constraint in place, so this rebuilds the table (same technique as any SQLite column
// migration) and copies every row across, only once, the first time this runs against an old copy.
if (db.prepare('SELECT "notnull" FROM pragma_table_info(\'notes_threads\') WHERE name = \'member_id\'').get()?.notnull) {
  // Dropping notes_threads while notes_messages still references it fails FK checks unless
  // enforcement is off for the duration; PRAGMA foreign_keys can't be toggled inside a transaction,
  // so it's flipped off before and back on after, not inside the db.transaction() call below.
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE notes_threads_new(
        id INTEGER PRIMARY KEY, member_id INTEGER UNIQUE REFERENCES users(id), member_label TEXT,
        hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (${NOW}));
      INSERT INTO notes_threads_new(id, member_id, created_at) SELECT id, member_id, created_at FROM notes_threads;
      DROP TABLE notes_threads;
      ALTER TABLE notes_threads_new RENAME TO notes_threads;
      CREATE TABLE notes_messages_new(
        id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES notes_threads(id),
        sender TEXT NOT NULL CHECK(sender IN ('warden', 'member')), author_id INTEGER REFERENCES users(id),
        body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (${NOW}), edited_at TEXT, deleted_at TEXT, read_at TEXT);
      INSERT INTO notes_messages_new(id, thread_id, sender, author_id, body, created_at, read_at)
        SELECT id, thread_id, sender, author_id, body, created_at, read_at FROM notes_messages;
      DROP TABLE notes_messages;
      ALTER TABLE notes_messages_new RENAME TO notes_messages;
      CREATE INDEX IF NOT EXISTS idx_notes_messages_thread ON notes_messages(thread_id, id);
    `);
  })();
  db.pragma('foreign_keys = ON');
}

// ---- report read-state: per viewer, so a reader can be shown which cleared reports they haven't
// opened yet. Purely a convenience marker, not part of any permanent record — deleting the report
// or the user is fine to cascade here (see cascadeDelete callers) since nothing else depends on it. ----
db.exec(`
CREATE TABLE IF NOT EXISTS report_reads(
  user_id INTEGER NOT NULL REFERENCES users(id),
  report_id INTEGER NOT NULL REFERENCES reports(id),
  read_at TEXT NOT NULL DEFAULT (${NOW}),
  PRIMARY KEY(user_id, report_id));
`);

// A curated pool of in-universe cover names. Assigned once, at signup, to every account that isn't
// the first (the founding Warden never needs one) — see server/index.js. Kept here so it sits next
// to the column it fills.
export const COVER_NAMES = [
  'Quicksilver', 'Ashen Quill', 'The Grey Courier', 'Nightingale’s Ledger', 'Frostwatch', 'The Broken Oath',
  'Coinless', 'The Hushed Bell', 'Wraithsbane', 'The Ember Scribe', 'Longshadow', 'The Salt Road',
  'Wintermark', 'The Silent Larder', 'Ravenspeak', 'The Cracked Standard', 'Duskwarden', 'The Tallow Candle',
  'Ironquill', 'The Drowned Bell', 'Palehold', 'The Wandering Deed', 'Stormtongue', 'The Empty Crest',
  'Nightbriar', 'The Last Waystone', 'Greymantle', 'The Untold Hearth', 'Fellhollow', 'The Rusted Oath',
];
