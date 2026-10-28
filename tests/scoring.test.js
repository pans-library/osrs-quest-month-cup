// Run with: node --test tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/scoring.js');

test('standard scoring matches 10/6/4/3/2 then 1', () => {
  assert.deepEqual(S.table(S.STANDARD, 8), [10, 6, 4, 3, 2, 1, 1, 1]);
});

test('custom scoring uses the list, then the "after" value', () => {
  const c = { mode: 'custom', points: [12, 6, 4], after: 0 };
  assert.deepEqual(S.table(c, 5), [12, 6, 4, 0, 0]);
});

test('dynamic scoring scales the top with roster size and halves by default', () => {
  assert.deepEqual(S.table({ mode: 'dynamic' }, 5), [10, 5, 3, 1, 1]);
  assert.deepEqual(S.table({ mode: 'dynamic' }, 3), [6, 3, 2]);
  assert.equal(S.pointsFor({ mode: 'dynamic' }, 1, 10), 20);
});

test('sanitize clamps and falls back to standard', () => {
  assert.deepEqual(S.sanitize(null), { mode: 'standard' });
  assert.deepEqual(S.sanitize({ mode: 'nonsense' }), { mode: 'standard' });
  assert.deepEqual(S.sanitize({ mode: 'custom', points: [] }), { mode: 'standard' });
  assert.deepEqual(S.sanitize({ mode: 'custom', points: [5000, -3, '7', 'x'], after: 2.6 }),
    { mode: 'custom', points: [1000, 0, 7, 0], after: 3 });
  assert.equal(S.sanitize({ mode: 'custom', points: Array(80).fill(1) }).points.length, 50);
  assert.deepEqual(S.sanitize({ mode: 'dynamic', perPlayer: 99, keep: 2, floor: -1 }),
    { mode: 'dynamic', perPlayer: 20, keep: 0.95, floor: 0 });
});

test('checks catch the 1st + last vs 2nd + 2nd rule', () => {
  const firstLast = (cfg, n) => S.checks(cfg, n, 6).find(c => c.id === 'first-last').ok;
  assert.equal(firstLast(S.STANDARD, 5), false);   // 10 + 2 = 12, not more than 12
  assert.equal(firstLast(S.STANDARD, 8), false);   // 10 + 1 = 11 < 12
  assert.equal(firstLast({ mode: 'custom', points: [12, 6, 4, 3, 2], after: 1 }, 8), true);
  assert.equal(firstLast({ mode: 'dynamic' }, 8), true);
});

test('checks flag a scheme where finishing scores nothing', () => {
  const c = { mode: 'custom', points: [10, 5], after: 0 };
  assert.equal(S.checks(c, 5, 6).find(x => x.id === 'participation').ok, false);
});

test('checks flag points that rise down the order', () => {
  const c = { mode: 'custom', points: [10, 4, 6], after: 1 };
  const m = S.checks(c, 5, 6).find(x => x.id === 'monotone');
  assert.equal(m.ok, false);
  assert.match(m.detail, /place 3/);
});

test('scenarios total correctly, with skipped quests scoring nothing', () => {
  const sc = S.scenarios(5, 6);
  const late = sc.find(s => s.id === 'late-vs-second');
  assert.deepEqual(S.play(S.STANDARD, late), { a: 40, b: 36, winner: 'a', ok: null });
  const mostly = sc.find(s => s.id === 'mostly-first-vs-second');
  assert.equal(S.play(S.STANDARD, mostly).ok, true);
});
