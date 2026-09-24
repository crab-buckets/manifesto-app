# Deploying Manifesto for real

This app is a single Node process (Express + SQLite) that also serves the built React app.
That's deliberately simple to run, but "simple to run" and "safe to expose to the internet"
aren't the same thing. This is the checklist for the gap between them.

## 1. Install and build

```
npm install
npm run build        # writes static files to dist/
```

`better-sqlite3` compiles a native module on install — if that fails, you're usually missing
build tools (`build-essential`/`python3` on Debian/Ubuntu) or need a Node version it has a
prebuilt binary for (check better-sqlite3's release notes for your Node major version).

## 2. Environment

Set these before starting the server (a `.env` file plus `dotenv`, or your process manager's
own env config — either is fine, nothing here is dotenv-specific):

- `NODE_ENV=production` — turns on the `Secure` cookie flag and HSTS. Don't run without it
  behind real TLS, and don't set it without real TLS (cookies won't be sent at all otherwise).
- `PORT` — defaults to 3000.
- `DB_PATH` — where the SQLite file lives. Defaults to `./manifesto.db`. Put it somewhere
  that's included in your backup path (see below), not inside a directory a deploy step wipes.
- `UPLOAD_DIR` — where uploaded attachments are stored on disk. Same advice as `DB_PATH`.
- `BACKUP_DIR` / `BACKUP_KEEP` — optional, see backups below.

## 3. Process manager

Don't run `node server/index.js` in a terminal and close the laptop. Use something that
restarts it on crash and on reboot. Either works fine for one process:

- **systemd** (if the box is Linux and you already manage other services this way) — a
  `.service` unit with `Restart=on-failure`, `WorkingDirectory` set to the repo, and the env
  vars above in an `EnvironmentFile`.
- **pm2** (`npm i -g pm2`, `pm2 start server/index.js --name manifesto`, `pm2 save`,
  `pm2 startup`) — less setup, fine for a single small server.

## 4. Reverse proxy + TLS

The app itself speaks plain HTTP. Don't put it on the internet directly — put nginx or Caddy
in front of it on 443 and proxy to `localhost:3000`. Caddy gets you free automatic TLS
(Let's Encrypt) with about five lines of Caddyfile; nginx needs certbot wired in separately.
Either way: the app already sets `trust proxy` and reads `X-Forwarded-*`, so login throttling
and rate limiting see the real client IP as long as your proxy sets those headers (both do,
by default).

Once you're behind real TLS, `NODE_ENV=production` (above) starts sending `Secure` cookies and
an HSTS header — without the proxy in place first, sign-in will silently stop working.

## 5. Firewall

Only the reverse proxy's ports (80/443) need to be open to the world. Bind the Node process to
`localhost` (it does, by default — Express's default `app.listen(port)` binds all interfaces,
so if the box has a public IP, put a firewall rule in front rather than relying on that) and
block direct access to the app's port from outside.

## 6. Backups

The database enforces "never truly delete" at the trigger level, but that's not a backup — a
disk failure or a bad `rm` still loses everything. `npm run backup` (or `node server/backup.js`
directly) takes a consistent snapshot via SQLite's `VACUUM INTO` — safe to run while the server
is live, unlike copying the `.db` file directly while WAL mode is active, which can catch it
mid-write. It writes timestamped copies to `backups/` (override with `BACKUP_DIR`) and prunes
old ones, keeping the most recent 14 by default (`BACKUP_KEEP`).

Wire it to a schedule — cron is enough:

```
0 * * * *  cd /path/to/manifesto && /usr/bin/npm run backup >> /var/log/manifesto-backup.log 2>&1
```

Then actually copy `backups/` (and the `uploads/` directory — attachments live on disk, not in
the database) somewhere off the box on a schedule too. A backup that lives next to the thing
it's backing up doesn't survive the failure it's meant for.

## 7. What the app already does for you

No further setup needed for these — listed so you know they're covered, not gaps:

- Passwords are scrypt-hashed with a random salt per user; sessions are random 256-bit tokens,
  stored server-side only as a SHA-256 hash, `httpOnly` + `sameSite=strict` (+ `Secure` in prod).
- Login/signup are throttled per IP+callsign (8 attempts / 10 min); every other `/api` route
  has a broader per-IP budget (300 req/min) against scraping or a runaway client.
- Security headers (CSP, `X-Frame-Options`, `X-Content-Type-Options`, HSTS in prod,
  `Permissions-Policy`) are set on every response.
- Uploaded files are validated by mime type and capped at 20MB, stored under random filenames
  (not the browser-supplied name), and served through an authenticated route rather than
  `express.static` — a redacted report's or removed attachment's file 404s for non-Wardens.
- Unhandled errors (bad input that throws, a malformed request body) are caught centrally and
  never leak a stack trace to the client — they're logged server-side instead.
- `reports`, `report_revisions`, `poi_revisions` and `attachments` all have triggers that make
  the database itself refuse a hard delete or an unauthorised rewrite of their core columns.

## 8. Still worth doing, not yet done

- **Log rotation.** `console.log`/`console.error` go to stdout/stderr; if you're not already
  capturing those through your process manager or systemd's journal with rotation, they'll grow
  forever. `pm2` and `journald` both handle this by default — just confirm it's on.
- **Monitoring/alerting.** Nothing here pages you if the process dies and the process manager's
  restart loop is failing, or if disk fills up. Even a cheap uptime-ping service catches most of
  that.
- **Dependency updates.** `npm audit` occasionally, and keep Node itself on an LTS release.
