// Quest Month Cup — Dink webhook receiver + scoreboard server.
// Zero dependencies: Node 22+ (node:http, node:sqlite).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CUP_START = process.env.CUP_START || '2026-11-01T00:00:00Z'; // ignore quest events before this
const MAX_BODY = 12 * 1024 * 1024; // Dink screenshots are capped at 8 MB

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
`);

// RSNs can arrive with spaces, underscores, hyphens or non-breaking spaces.
const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s_\- ]+/g, ' ').trim().toLowerCase();
const nowIso = () => new Date().toISOString();

/* ---------- state ---------- */
function state(includeAdmin) {
  const players = db.prepare('SELECT id, rsn FROM players ORDER BY rsn COLLATE NOCASE').all();
  const quests = db.prepare('SELECT id, name, release_date AS releaseDate, created_at AS createdAt FROM quests').all();
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

  const out = { players, quests, finishes, cupStart: CUP_START, admin: !!includeAdmin };
  if (includeAdmin) {
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

function recordDink(p) {
  if (!p || p.type !== 'QUEST') return 'ignored';
  const quest = p.extra && p.extra.questName;
  if (!p.playerName || !quest) return 'ignored';
  const slim = JSON.stringify({ type: p.type, playerName: p.playerName, accountType: p.accountType,
    seasonalWorld: p.seasonalWorld, dinkAccountHash: p.dinkAccountHash, extra: p.extra });
  db.prepare(`INSERT INTO events (rsn, rsn_norm, quest_name, quest_norm, at, source, seasonal, payload)
    VALUES (?, ?, ?, ?, ?, 'dink', ?, ?)`)
    .run(String(p.playerName), norm(p.playerName), String(quest), norm(quest), nowIso(), p.seasonalWorld ? 1 : 0, slim);
  console.log(`quest: ${p.playerName} completed ${quest}${p.seasonalWorld ? ' (seasonal, not counted)' : ''}`);
  return 'recorded';
}

/* ---------- http ---------- */
const PUBLIC = path.join(__dirname, 'public');
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
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
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };
const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
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
        const { rsn } = await json(req);
        if (!norm(rsn)) return send(res, 400, { error: 'Enter an RSN.' });
        try { db.prepare('INSERT INTO players (rsn, rsn_norm, created_at) VALUES (?, ?, ?)').run(String(rsn).trim(), norm(rsn), nowIso()); }
        catch (e) { if (isUnique(e)) return send(res, 409, { error: `${rsn} is already on the roster.` }); throw e; }
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/players\/\d+$/.test(p)) {
        db.prepare('DELETE FROM players WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/quests') {
        const { name, releaseDate } = await json(req);
        if (!norm(name)) return send(res, 400, { error: 'Enter a quest name.' });
        const date = /^\d{4}-\d{2}-\d{2}$/.test(releaseDate || '') ? releaseDate : '';
        try { db.prepare('INSERT INTO quests (name, name_norm, release_date, created_at) VALUES (?, ?, ?, ?)').run(String(name).trim(), norm(name), date, nowIso()); }
        catch (e) { if (isUnique(e)) return send(res, 409, { error: `${name} is already in the cup.` }); throw e; }
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/quests\/\d+$/.test(p)) {
        db.prepare('DELETE FROM quests WHERE id = ?').run(id); // events are kept; re-adding the quest restores its finishes
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/events') {
        // Manual backfill, e.g. when the NAS was down. `at` is an ISO time.
        const { rsn, questName, at } = await json(req);
        const when = new Date(at || Date.now());
        if (!norm(rsn) || !norm(questName) || isNaN(when)) return send(res, 400, { error: 'Player, quest and a valid time are required.' });
        db.prepare(`INSERT INTO events (rsn, rsn_norm, quest_name, quest_norm, at, source) VALUES (?, ?, ?, ?, ?, 'manual')`)
          .run(String(rsn), norm(rsn), String(questName), norm(questName), when.toISOString());
        return send(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/events\/\d+$/.test(p)) {
        db.prepare('DELETE FROM events WHERE id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${p.startsWith('/hook/') ? '/hook/***' : p}: ${e.message}`);
    send(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'Malformed request body.' : 'Server error.' });
  }
});

server.listen(PORT, () => console.log(`Quest Month Cup listening on :${PORT} (counting events from ${CUP_START})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
