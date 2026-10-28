// Quest Month Cup — Dink webhook receiver + scoreboard server.
// Zero dependencies: Node 22+ (node:http, node:sqlite).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Scoring = require('./public/scoring.js');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CUP_START = process.env.CUP_START || '2026-11-01T00:00:00Z'; // ignore quest events before this
const SEED_FILE = process.env.SEED_FILE || path.join(__dirname, 'seed', 'quests.json');
const WIKI_BASE = 'https://oldschool.runescape.wiki/w/';
const MAX_BODY = 12 * 1024 * 1024; // Dink screenshots are capped at 8 MB
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT_MB || 48) * 1024 * 1024; // request bytes held in memory at once
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 20000); // stop accepting webhook posts past this many stored events
const MAX_RSN = 12, MAX_QUEST = 100; // in-game names are at most 12 characters

if (WEBHOOK_TOKEN.length < 16 || ADMIN_TOKEN.length < 16) {
  console.error('WEBHOOK_TOKEN and ADMIN_TOKEN must each be set to at least 16 characters.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'cup.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY, rsn TEXT NOT NULL, rsn_norm TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE,
    release_date TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, rsn TEXT NOT NULL, rsn_norm TEXT NOT NULL,
    quest_name TEXT NOT NULL, quest_norm TEXT NOT NULL, at TEXT NOT NULL,
    source TEXT NOT NULL, seasonal INTEGER NOT NULL DEFAULT 0, payload TEXT);
  CREATE INDEX IF NOT EXISTS events_quest ON events (quest_norm, at);
  CREATE TABLE IF NOT EXISTS seed_log (name_norm TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// Migrations for databases created by earlier versions.
if (!db.prepare('PRAGMA table_info(quests)').all().some(c => c.name === 'wiki_url')) {
  db.exec("ALTER TABLE quests ADD COLUMN wiki_url TEXT NOT NULL DEFAULT ''");
}

// RSNs can arrive with spaces, underscores, hyphens or non-breaking spaces.
const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s_\- ]+/g, ' ').trim().toLowerCase();
const nowIso = () => new Date().toISOString();
const str = (v) => (typeof v === 'string' ? v : ''); // request fields must be strings; anything else counts as empty
const logSafe = (v) => String(v).replace(/[\x00-\x1f\x7f]/g, ' '); // no forged log lines
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

// Wiki page for a quest: an explicit override, or the wiki's own title convention.
const wikiFor = (name) => WIKI_BASE + encodeURIComponent(String(name).trim().replace(/ /g, '_'));
function cleanWiki(url) {
  if (!url) return '';
  let u;
  try { u = new URL(String(url)); } catch { throw new UserError('Wiki link must be a full https://oldschool.runescape.wiki/ address.'); }
  if (u.protocol !== 'https:' || u.hostname !== 'oldschool.runescape.wiki') {
    throw new UserError('Wiki link must point to https://oldschool.runescape.wiki/.');
  }
  return u.href;
}
class UserError extends Error {}

/* ---------- settings ---------- */
const getSetting = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : undefined; };
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
// SCORING in the environment fixes the scheme: a mode name (linear, standard, dynamic) or JSON such as
// {"mode":"custom","points":[12,6,4,3,2],"after":1}. When set, the organiser can't change it from the page.
const ENV_SCORING = (() => {
  const raw = (process.env.SCORING || '').trim();
  if (!raw) return null;
  let cfg;
  try { cfg = raw.startsWith('{') ? JSON.parse(raw) : { mode: raw.toLowerCase() }; } catch { cfg = null; }
  const clean = cfg && Scoring.MODES.includes(cfg.mode) ? Scoring.sanitize(cfg) : null;
  if (!clean || clean.mode !== cfg.mode) {
    console.error(`SCORING must be one of ${Scoring.MODES.filter(m => m !== 'custom').join(', ')}, or JSON like {"mode":"custom","points":[12,6,4,3,2],"after":1}. Got: ${raw.slice(0, 200)}`);
    process.exit(1);
  }
  return clean;
})();
const scoring = () => ENV_SCORING || Scoring.sanitize(getSetting('scoring'));

/* ---------- seed ---------- */
// Quests in the seed file are added once each. A seeded quest the organiser later
// removes stays removed, and quests added to the file in a newer image appear on restart.
function applySeed() {
  if (!fs.existsSync(SEED_FILE)) return;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); }
  catch (e) { console.error(`Seed file ${SEED_FILE} is not valid JSON: ${e.message}`); return; }
  const seen = db.prepare('SELECT 1 FROM seed_log WHERE name_norm = ?');
  const addQuest = db.prepare(`INSERT OR IGNORE INTO quests (name, name_norm, release_date, wiki_url, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const log = db.prepare('INSERT INTO seed_log (name_norm, applied_at) VALUES (?, ?)');
  let added = 0;
  for (const q of Array.isArray(seed.quests) ? seed.quests : []) {
    const n = norm(q && q.name);
    if (!n || seen.get(n)) continue;
    let wiki = '';
    try { wiki = cleanWiki(q.wikiUrl); } catch (e) { console.error(`Seed quest "${q.name}": ${e.message}`); }
    added += addQuest.run(String(q.name).trim(), n, isDate(q.releaseDate) ? q.releaseDate : '', wiki, nowIso()).changes;
    log.run(n, nowIso());
  }
  if (added) console.log(`Seeded ${added} quest${added === 1 ? '' : 's'} from ${SEED_FILE}`);
}
applySeed();

/* ---------- state ---------- */
function state(includeAdmin) {
  const players = db.prepare('SELECT id, rsn FROM players ORDER BY rsn COLLATE NOCASE').all();
  const quests = db.prepare('SELECT id, name, release_date AS releaseDate, wiki_url, created_at AS createdAt FROM quests').all()
    .map(({ wiki_url, ...q }) => ({ ...q, wikiUrl: wiki_url || wikiFor(q.name), wikiCustom: !!wiki_url }));
  const roster = new Map(db.prepare('SELECT id, rsn_norm FROM players').all().map(p => [p.rsn_norm, p.id]));

  // First qualifying event per (quest, player), in time order.
  const finishes = [];
  const pick = db.prepare(`SELECT id, rsn_norm, at, source FROM events
    WHERE quest_norm = ? AND seasonal = 0 AND at >= ? ORDER BY at, id`);
  for (const q of db.prepare('SELECT id, name_norm FROM quests').all()) {
    const seen = new Set();
    for (const e of pick.all(q.name_norm, CUP_START)) {
      const playerId = roster.get(e.rsn_norm);
      if (!playerId || seen.has(playerId)) continue;
      seen.add(playerId);
      finishes.push({ id: e.id, questId: q.id, playerId, finishedAt: e.at, source: e.source });
    }
  }

  const out = { players, quests, finishes, scoring: scoring(), scoringLocked: !!ENV_SCORING, cupStart: CUP_START, admin: !!includeAdmin };
  if (includeAdmin) {
    out.hookPath = '/hook/' + WEBHOOK_TOKEN; // shown only to the organiser, for sharing with players
    // Quest names seen from roster players that aren't on the cup list yet.
    const known = new Set(db.prepare('SELECT name_norm FROM quests').all().map(r => r.name_norm));
    const rows = db.prepare(`SELECT quest_name AS name, quest_norm, COUNT(*) AS n, MIN(at) AS firstAt FROM events
      WHERE seasonal = 0 AND at >= ? GROUP BY quest_norm ORDER BY firstAt DESC`).all(CUP_START);
    out.unmatchedQuests = rows.filter(r => !known.has(r.quest_norm)).map(({ name, n, firstAt }) => ({ name, n, firstAt }));
    out.unknownPlayers = db.prepare(`SELECT rsn, COUNT(*) AS n FROM events WHERE at >= ?
      AND rsn_norm NOT IN (SELECT rsn_norm FROM players) GROUP BY rsn_norm`).all(CUP_START);
  }
  return out;
}

/* ---------- dink ---------- */
// Dink sends application/json, or multipart/form-data with a `payload_json` part (plus an optional `file` image).
function extractPayload(req, body) {
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return JSON.parse(body.toString('utf8'));
  const m = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) throw new Error('unsupported content type');
  const boundary = '--' + (m[1] || m[2]);
  const raw = body.toString('latin1'); // byte-preserving, so the image part can't break parsing
  for (const part of raw.split(boundary)) {
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd < 0) continue;
    const head = part.slice(0, headEnd);
    if (!/name="payload_json"/i.test(head)) continue;
    const content = part.slice(headEnd + 4).replace(/\r\n$/, '');
    return JSON.parse(Buffer.from(content, 'latin1').toString('utf8'));
  }
  throw new Error('no payload_json part');
}

const countEvents = db.prepare('SELECT COUNT(*) AS n FROM events');
// Only events from the cup itself count as earlier finishes, so a pre-start test post can't block the real one.
const dinkDuplicate = db.prepare(`SELECT 1 FROM events WHERE rsn_norm = ? AND quest_norm = ? AND seasonal = ? AND source = 'dink' AND at >= ?`);
function recordDink(p) {
  if (!p || typeof p !== 'object' || p.type !== 'QUEST') return 'ignored';
  const rsn = str(p.playerName).trim(), quest = str(p.extra && p.extra.questName).trim();
  if (!rsn || !quest || rsn.length > MAX_RSN || quest.length > MAX_QUEST) return 'ignored';
  const seasonal = p.seasonalWorld === true ? 1 : 0;
  if (dinkDuplicate.get(norm(rsn), norm(quest), seasonal, CUP_START)) return 'duplicate'; // only the first completion counts anyway
  if (countEvents.get().n >= MAX_EVENTS) { console.error(`Event limit (${MAX_EVENTS}) reached; ignoring webhook posts.`); return 'ignored'; }
  // Keep only small, known fields from the payload.
  const slim = JSON.stringify({ accountType: str(p.accountType).slice(0, 32), seasonalWorld: !!seasonal,
    dinkAccountHash: String(p.dinkAccountHash ?? '').slice(0, 64) });
  db.prepare(`INSERT INTO events (rsn, rsn_norm, quest_name, quest_norm, at, source, seasonal, payload)
    VALUES (?, ?, ?, ?, ?, 'dink', ?, ?)`)
    .run(rsn, norm(rsn), quest, norm(quest), nowIso(), seasonal, slim);
  console.log(`quest: ${logSafe(rsn)} completed ${logSafe(quest)}${seasonal ? ' (seasonal, not counted)' : ''}`);
  return 'recorded';
}

/* ---------- http ---------- */
const PUBLIC = path.join(__dirname, 'public');
// Fixed allowlist of static files; nothing else under public/ is reachable by path.
const ICONS = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/favicon.ico': ['favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/scoring.js': ['scoring.js', 'text/javascript; charset=utf-8'],
};
const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
// The page is read once at start-up so its inline script can be allowed by hash rather than 'unsafe-inline'.
const cspFor = (html) => {
  const hashes = [...html.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return ["default-src 'none'", `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
    "connect-src 'self'", "img-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
};
const PAGES = Object.fromEntries([['/', 'index.html'], ['/index.html', 'index.html'], ['/scoring', 'scoring.html']]
  .map(([route, file]) => { const html = fs.readFileSync(path.join(PUBLIC, file)); return [route, { html, csp: cspFor(html) }]; }));
const send = (res, code, obj) => {
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const isAdmin = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), ADMIN_TOKEN);
};
// Bodies are buffered, so the total held across all requests is capped. Past the cap a request
// gets 503 instead of the process growing until the container's memory limit kills it.
let inflight = 0;
class BusyError extends Error {}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const release = () => { if (!done) { done = true; inflight -= size; } };
    const fail = (e) => { release(); reject(e); req.resume(); };
    req.on('data', (c) => {
      if (done) return;
      size += c.length; inflight += c.length;
      if (size > MAX_BODY) return fail(new Error('too large'));
      if (inflight > MAX_INFLIGHT) return fail(new BusyError('busy'));
      chunks.push(c);
    });
    req.on('end', () => { if (done) return; release(); resolve(Buffer.concat(chunks)); });
    req.on('error', fail);
    req.on('close', release);
  });
}
const json = async (req) => {
  const b = await readBody(req);
  const v = b.length ? JSON.parse(b.toString('utf8')) : {};
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; // bodies must be JSON objects
};
const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));

const server = http.createServer(async (req, res) => {
  // Only the path is needed. Parsing with new URL() throws on inputs like "//[" and crashed the process.
  const p = String(req.url || '/').split('?')[0];
  try {
    if (req.method === 'POST' && p.startsWith('/hook/')) {
      if (!safeEqual(p.slice(6), WEBHOOK_TOKEN)) return send(res, 404, { error: 'not found' });
      const result = recordDink(extractPayload(req, await readBody(req)));
      return send(res, 200, { ok: true, result });
    }
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, state(isAdmin(req)));

    if (p.startsWith('/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Organiser key required.' });
      const id = Number(p.split('/')[3]);

      if (req.method === 'POST' && p === '/api/players') {
        const rsn = str((await json(req)).rsn).trim();
        if (!norm(rsn) || rsn.length > MAX_RSN) return send(res, 400, { error: 'Enter an RSN of up to 12 characters.' });
        try { db.prepare('INSERT INTO players (rsn, rsn_norm, created_at) VALUES (?, ?, ?)').run(String(rsn).trim(), norm(rsn), nowIso()); }
        catch (e) { if (isUnique(e)) return send(res, 409, { error: `${rsn} is already on the roster.` }); throw e; }
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/players\/\d+$/.test(p)) {
        db.prepare('DELETE FROM players WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/quests') {
        const body = await json(req);
        const name = str(body.name).trim(), releaseDate = str(body.releaseDate), wikiUrl = str(body.wikiUrl);
        if (!norm(name) || name.length > MAX_QUEST) return send(res, 400, { error: 'Enter a quest name of up to 100 characters.' });
        const wiki = cleanWiki(wikiUrl);
        try { db.prepare('INSERT INTO quests (name, name_norm, release_date, wiki_url, created_at) VALUES (?, ?, ?, ?, ?)').run(String(name).trim(), norm(name), isDate(releaseDate) ? releaseDate : '', wiki, nowIso()); }
        catch (e) { if (isUnique(e)) return send(res, 409, { error: `${name} is already in the cup.` }); throw e; }
        return send(res, 201, { ok: true });
      }
      if (req.method === 'PATCH' && /^\/api\/quests\/\d+$/.test(p)) {
        // Edit a quest's release date and wiki link. An empty wikiUrl restores the default link.
        const body = await json(req);
        const q = db.prepare('SELECT id FROM quests WHERE id = ?').get(id);
        if (!q) return send(res, 404, { error: 'That quest no longer exists.' });
        if ('releaseDate' in body) db.prepare('UPDATE quests SET release_date = ? WHERE id = ?').run(isDate(str(body.releaseDate)) ? body.releaseDate : '', id);
        if ('wikiUrl' in body) db.prepare('UPDATE quests SET wiki_url = ? WHERE id = ?').run(cleanWiki(str(body.wikiUrl)), id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/quests\/\d+$/.test(p)) {
        db.prepare('DELETE FROM quests WHERE id = ?').run(id); // events are kept; re-adding the quest restores its finishes
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && p === '/api/scoring') {
        if (ENV_SCORING) return send(res, 409, { error: 'Scoring is set by the server\'s SCORING setting. Change it there and restart.' });
        const cfg = Scoring.sanitize(await json(req));
        setSetting('scoring', cfg);
        return send(res, 200, { ok: true, scoring: cfg });
      }
      if (req.method === 'POST' && p === '/api/events') {
        // Manual backfill, e.g. when the NAS was down. `at` is an ISO time.
        const body = await json(req);
        const rsn = str(body.rsn).trim(), questName = str(body.questName).trim();
        const when = new Date(str(body.at) || Date.now());
        const year = when.getUTCFullYear();
        if (!norm(rsn) || !norm(questName) || rsn.length > MAX_RSN || questName.length > MAX_QUEST || isNaN(when) || year < 2001 || year > 2100) {
          return send(res, 400, { error: 'Player, quest and a valid time are required.' });
        }
        db.prepare(`INSERT INTO events (rsn, rsn_norm, quest_name, quest_norm, at, source) VALUES (?, ?, ?, ?, ?, 'manual')`)
          .run(rsn, norm(rsn), questName, norm(questName), when.toISOString());
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/events\/\d+$/.test(p)) {
        db.prepare('DELETE FROM events WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    const icon = ICONS[p];
    if (req.method === 'GET' && icon) {
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': icon[1], 'cache-control': icon[0].endsWith('.js') ? 'no-cache' : 'public, max-age=604800' });
      return fs.createReadStream(path.join(PUBLIC, icon[0])).pipe(res);
    }
    const page = req.method === 'GET' && PAGES[p];
    if (page) {
      res.writeHead(200, { ...BASE_HEADERS, 'content-security-policy': page.csp, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(page.html);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!(e instanceof UserError) && !(e instanceof BusyError)) console.error(`${req.method} ${p.startsWith('/hook/') ? '/hook/***' : logSafe(p).slice(0, 200)}: ${e.message}`);
    if (e instanceof UserError) return send(res, 400, { error: e.message });
    if (e instanceof BusyError) { res.setHeader('retry-after', '5'); return send(res, 503, { error: 'Server busy, try again shortly.' }); }
    if (e.message === 'too large') return send(res, 413, { error: 'Request too large.' });
    send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'Malformed request body.' : 'Server error.' });
  }
});

// Bound slow or stalled clients.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
// Last line of defence: log and keep serving rather than exiting on an unexpected rejection.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.message));

server.listen(PORT, () => console.log(`Quest Month Cup listening on :${PORT} (counting events from ${CUP_START}; scoring ${ENV_SCORING ? `${ENV_SCORING.mode} from SCORING` : `${scoring().mode}`})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
