import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSettings, openDb, setSettings } from '../src/db.js';
import { fill, fmtDuration, parseDuration, pickRandom } from '../src/util.js';

test('parseDuration reads common lengths', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h30m'), 9_000_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration(' 1 h '), 3_600_000);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('0m'), null);
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(90_061_000), '1d 1h 1m');
  assert.equal(fmtDuration(30_000), '30s');
});

test('fill replaces known variables only', () => {
  assert.equal(fill('Hi {user} to {server} ({count}) {nope}', { user: '<@1>', server: 'S', count: 5 }), 'Hi <@1> to S (5) {nope}');
});

test('pickRandom returns distinct items', () => {
  const out = pickRandom([1, 2, 3, 4, 5], 3);
  assert.equal(out.length, 3);
  assert.equal(new Set(out).size, 3);
  assert.equal(pickRandom([1], 5).length, 1);
});

test('settings merge over defaults', () => {
  const db = openDb(':memory:');
  const defaults = { a: 1, b: 'x', list: [] as string[] };
  assert.deepEqual(getSettings(db, 'g', 'k', defaults), defaults);
  setSettings(db, 'g', 'k', defaults, { a: 2 });
  assert.deepEqual(getSettings(db, 'g', 'k', defaults), { a: 2, b: 'x', list: [] });
  assert.deepEqual(getSettings(db, 'other', 'k', defaults), defaults);
  // make sure callers can't mutate the defaults
  getSettings(db, 'g', 'k', defaults).list.push('y');
  assert.deepEqual(defaults.list, []);
});
