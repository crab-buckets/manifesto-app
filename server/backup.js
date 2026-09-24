// A consistent hot-copy of the live database, safe to run while the server is up (VACUUM INTO
// takes SQLite's own read lock and produces a single self-contained file, unlike copying the .db
// file directly while WAL mode is active). Run it on a schedule — a cron entry or systemd timer:
//   0 * * * *  cd /path/to/manifesto && npm run backup
// Old backups are pruned to the most recent KEEP copies so this doesn't grow without bound; the
// database itself never deletes report/revision/attachment data, only these rotating snapshots.
import { db } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.BACKUP_DIR || path.join(HERE, '../backups');
const KEEP = +(process.env.BACKUP_KEEP || 14);
fs.mkdirSync(DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(DIR, `manifesto-${stamp}.db`);
db.prepare(`VACUUM INTO '${dest.replace(/'/g, "''")}'`).run();
console.log(`Backed up to ${dest}`);

const old = fs.readdirSync(DIR).filter((f) => f.startsWith('manifesto-') && f.endsWith('.db')).sort();
for (const f of old.slice(0, Math.max(0, old.length - KEEP))) {
  fs.unlinkSync(path.join(DIR, f));
  console.log(`Pruned ${f}`);
}
