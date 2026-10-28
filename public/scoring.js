// Quest Month Cup scoring: one file shared by the scoreboard, the scoring lab, the server
// (to validate settings) and the tests, so they always agree on the numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CupScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LINEAR = { mode: 'linear' };
  const STANDARD = { mode: 'standard' };
  const DEFAULT = LINEAR; // used when nothing is configured
  const MODES = ['linear', 'standard', 'dynamic', 'custom'];
  const STANDARD_POINTS = [10, 6, 4, 3, 2];
  const STANDARD_AFTER = 1;
  const DYNAMIC_DEFAULTS = { perPlayer: 2, keep: 0.5, floor: 1 };

  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const clampNum = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };

  // Turn anything (stored JSON, a request body) into a valid config. Unknown input becomes the default.
  function sanitize(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ...DEFAULT };
    if (cfg.mode === 'linear') return { ...LINEAR };
    if (cfg.mode === 'standard') return { ...STANDARD };
    if (cfg.mode === 'custom') {
      const pts = (Array.isArray(cfg.points) ? cfg.points : []).slice(0, 50).map(p => clampInt(p, 0, 1000, 0));
      if (!pts.length) return { ...DEFAULT };
      return { mode: 'custom', points: pts, after: clampInt(cfg.after, 0, 1000, 0) };
    }
    if (cfg.mode === 'dynamic') {
      return {
        mode: 'dynamic',
        perPlayer: Math.round(clampNum(cfg.perPlayer, 0.5, 20, DYNAMIC_DEFAULTS.perPlayer) * 10) / 10,
        keep: Math.round(clampNum(cfg.keep, 0.1, 0.95, DYNAMIC_DEFAULTS.keep) * 100) / 100,
        floor: clampInt(cfg.floor, 0, 10, DYNAMIC_DEFAULTS.floor),
      };
    }
    return { ...DEFAULT };
  }

  // Points for finishing in `place` (1-based) when `players` are on the roster.
  function pointsFor(cfg, place, players) {
    const c = sanitize(cfg);
    const n = Math.max(2, players | 0);
    if (c.mode === 'custom') return place <= c.points.length ? c.points[place - 1] : c.after;
    if (c.mode === 'linear') return Math.max(1, n - place + 1); // n players: n, n-1, … 1
    if (c.mode === 'dynamic') {
      // First place is worth perPlayer x roster size; each place keeps `keep` of the one above.
      const top = Math.max(1, Math.round(c.perPlayer * n));
      return Math.max(c.floor, Math.round(top * Math.pow(c.keep, place - 1)));
    }
    return place <= STANDARD_POINTS.length ? STANDARD_POINTS[place - 1] : STANDARD_AFTER;
  }

  // Points for places 1..count, for display.
  const table = (cfg, players, count = players) =>
    Array.from({ length: Math.max(1, count) }, (_, i) => pointsFor(cfg, i + 1, players));

  // Short label, e.g. "10 · 6 · 4 · 3 · 2, then 1".
  function describe(cfg, players) {
    const c = sanitize(cfg);
    if (c.mode === 'dynamic' || c.mode === 'linear') {
      const t = table(c, players, Math.min(players, 6));
      return `${t.join(' · ')}${players > 6 ? ' …' : ''} for ${players} players`;
    }
    const pts = c.mode === 'custom' ? c.points : STANDARD_POINTS;
    const after = c.mode === 'custom' ? c.after : STANDARD_AFTER;
    return `${pts.join(' · ')}, then ${after}`;
  }

  // Reference curves for comparison in the lab. Not stored; the organiser can copy one as Custom.
  const REFERENCES = {
    racing: () => ({ mode: 'custom', points: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], after: 0 }),
  };

  /* ---------- seasons, scenarios and checks ---------- */

  // A placement list has one entry per quest: a place number, or null for "didn't finish".
  const total = (cfg, placements, players) =>
    placements.reduce((sum, p) => sum + (p == null ? 0 : pointsFor(cfg, p, players)), 0);

  const always = (q, place) => Array(q).fill(place);

  // Head-to-head season matchups. `expect`: 'a' means A should finish ahead,
  // 'either' means it is a judgement call the organiser should look at.
  function scenarios(players, quests) {
    const n = Math.max(2, players), q = Math.max(2, quests);
    return [
      { id: 'first-last-vs-seconds', title: '1st + last vs 2nd + 2nd', note: 'Two quests. Should a win make up for a last place?',
        a: { label: '1st, then last', places: [1, n] }, b: { label: '2nd twice', places: [2, 2] }, expect: 'a' },
      { id: 'mostly-first-vs-second', title: 'Mostly 1st vs always 2nd', note: `Wins ${q - 1} of ${q}, comes last once.`,
        a: { label: `1st ×${q - 1}, last ×1`, places: [...always(q - 1, 1), n] }, b: { label: `2nd ×${q}`, places: always(q, 2) }, expect: 'a' },
      { id: 'first-vs-second', title: 'Always 1st vs always 2nd', note: 'How big is a winning streak\'s lead?',
        a: { label: `1st ×${q}`, places: always(q, 1) }, b: { label: `2nd ×${q}`, places: always(q, 2) }, expect: 'a' },
      { id: 'second-vs-third', title: 'Always 2nd vs always 3rd', note: 'Does consistency further down still separate players?',
        a: { label: `2nd ×${q}`, places: always(q, 2) }, b: { label: `3rd ×${q}`, places: always(q, 3) }, expect: 'a' },
      { id: 'last-vs-none', title: 'Always last vs never finishes', note: 'Finishing at all should be worth something.',
        a: { label: `last ×${q}`, places: always(q, n) }, b: { label: 'no finishes', places: always(q, null) }, expect: 'a' },
      { id: 'alternate-vs-second', title: 'Alternates 1st and last vs always 2nd', note: 'Boom-and-bust against steady.',
        a: { label: '1st, last, 1st…', places: Array.from({ length: q }, (_, i) => (i % 2 ? n : 1)) },
        b: { label: `2nd ×${q}`, places: always(q, 2) }, expect: 'either' },
      { id: 'skip-half-vs-third', title: 'Wins half, skips half vs always 3rd', note: 'Does skipping quests pay off?',
        a: { label: '1st, skip, 1st…', places: Array.from({ length: q }, (_, i) => (i % 2 ? null : 1)) },
        b: { label: `3rd ×${q}`, places: always(q, 3) }, expect: 'either' },
      { id: 'late-vs-second', title: 'Joins late then always 1st vs always 2nd', note: 'Misses the first two quests.',
        a: { label: `skip ×2, 1st ×${q - 2}`, places: [null, null, ...always(q - 2, 1)] },
        b: { label: `2nd ×${q}`, places: always(q, 2) }, expect: 'either' },
    ].map(s => ({ ...s, players: n, quests: s.a.places.length }));
  }

  function play(cfg, s) {
    const a = total(cfg, s.a.places, s.players), b = total(cfg, s.b.places, s.players);
    const winner = a > b ? 'a' : b > a ? 'b' : 'tie';
    return { a, b, winner, ok: s.expect === 'either' ? null : winner === s.expect };
  }

  // Properties a scheme can pass or fail, with the numbers behind each verdict.
  function checks(cfg, players, quests) {
    const n = Math.max(2, players), q = Math.max(2, quests);
    const p = (k) => pointsFor(cfg, k, n);
    const t = table(cfg, n);
    const firstDrop = t.findIndex((v, i) => i > 0 && v > t[i - 1]);
    return [
      { id: 'monotone', label: 'Better places never score less', ok: firstDrop === -1,
        detail: firstDrop === -1 ? 'points never rise down the order' : `place ${firstDrop + 1} scores more than place ${firstDrop}` },
      { id: 'win-bonus', label: '1st scores more than 2nd', ok: p(1) > p(2), detail: `${p(1)} vs ${p(2)}` },
      { id: 'participation', label: 'Finishing last beats not finishing', ok: p(n) > 0, detail: `last place scores ${p(n)}` },
      { id: 'first-last', label: '1st + last beats 2nd + 2nd', ok: p(1) + p(n) > 2 * p(2),
        detail: `${p(1)} + ${p(n)} = ${p(1) + p(n)} vs ${2 * p(2)}` },
      { id: 'mostly-first', label: `${q - 1} wins and a last beat ${q} 2nds`, ok: (q - 1) * p(1) + p(n) > q * p(2),
        detail: `${(q - 1) * p(1) + p(n)} vs ${q * p(2)}` },
    ];
  }

  // A few numbers that describe a curve's shape.
  function metrics(cfg, players) {
    const n = Math.max(2, players), t = table(cfg, n);
    const sum = t.reduce((a, b) => a + b, 0) || 1;
    return {
      top: t[0],
      winShare: Math.round((t[0] / sum) * 100),      // % of one quest's points that go to 1st
      winOverSecond: t[1] ? Math.round((t[0] / t[1]) * 10) / 10 : null,
      swing: t[0],                                     // most one quest can move a lead (1st vs not finishing)
    };
  }

  return { LINEAR, STANDARD, DEFAULT, MODES, STANDARD_POINTS, STANDARD_AFTER, DYNAMIC_DEFAULTS, REFERENCES,
    sanitize, pointsFor, table, describe, total, scenarios, play, checks, metrics };
});
