import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickWinners } from '../src/modules/giveaways.js';
import { levelFromXp, progressBar, xpForLevel } from '../src/modules/levels.js';
import { bar, splitOptions, tally } from '../src/modules/polls.js';

test('xp curve', () => {
  assert.equal(xpForLevel(0), 100);
  assert.equal(xpForLevel(1), 155);
  assert.equal(xpForLevel(2), 220);
  assert.equal(xpForLevel(10), 1100);
});

test('level from xp', () => {
  assert.deepEqual(levelFromXp(0), { level: 0, into: 0, needed: 100 });
  assert.deepEqual(levelFromXp(99), { level: 0, into: 99, needed: 100 });
  assert.deepEqual(levelFromXp(100), { level: 1, into: 0, needed: 155 });
  assert.deepEqual(levelFromXp(254), { level: 1, into: 154, needed: 155 });
  assert.deepEqual(levelFromXp(255), { level: 2, into: 0, needed: 220 });
  assert.equal(levelFromXp(-50).level, 0);

  let total = 0;
  for (let n = 0; n < 50; n++) total += xpForLevel(n);
  assert.deepEqual(levelFromXp(total), { level: 50, into: 0, needed: xpForLevel(50) });
  assert.equal(levelFromXp(total - 1).level, 49);
});

test('progress bar', () => {
  assert.equal(progressBar(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(progressBar(0.35), '▰▰▰▱▱▱▱▱▱▱');
  assert.equal(progressBar(0.99), '▰▰▰▰▰▰▰▰▰▱');
  assert.equal(progressBar(1), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(progressBar(NaN), '▱▱▱▱▱▱▱▱▱▱');
});

test('poll options split on | or commas', () => {
  assert.deepEqual(splitOptions('Pizza | Tacos |  | Sushi'), ['Pizza', 'Tacos', 'Sushi']);
  assert.deepEqual(splitOptions('red, green,blue'), ['red', 'green', 'blue']);
  assert.deepEqual(splitOptions('1,000 | 2,000'), ['1,000', '2,000']);
});

test('poll tally', () => {
  const t = tally(3, [0, 0, 1, 2, 0]);
  assert.deepEqual(t.counts, [3, 1, 1]);
  assert.equal(t.total, 5);
  assert.deepEqual(t.percents, [60, 20, 20]);
  assert.deepEqual(t.winners, [0]);

  assert.deepEqual(tally(3, [0, 1]).winners, [0, 1]);
  const empty = tally(2, []);
  assert.deepEqual(empty.percents, [0, 0]);
  assert.deepEqual(empty.winners, []);
  assert.deepEqual(tally(2, [5, -1, 1]).counts, [0, 1]);

  assert.equal(bar(0, 4), '░░░░');
  assert.equal(bar(50, 4), '██░░');
  assert.equal(bar(100, 4), '████');
});

test('giveaway winners', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'];
  for (let n = 0; n < 50; n++) {
    const w = pickWinners(entries, 3);
    assert.equal(w.length, 3);
    assert.equal(new Set(w).size, 3);
    assert.ok(w.every((id) => entries.includes(id)));
  }
  assert.equal(pickWinners(entries, 10).length, 5);
  assert.deepEqual(pickWinners([], 2), []);
  assert.deepEqual(pickWinners(['a', 'a', 'b'], 5).sort(), ['a', 'b']);

  const rerolled = pickWinners(entries, 5, ['a', 'b']);
  assert.deepEqual(rerolled.sort(), ['c', 'd', 'e']);
});
