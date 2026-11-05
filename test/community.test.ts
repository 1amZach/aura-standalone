import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunk, looksLikeEmoji, planToggle } from '../src/modules/roles.js';
import { cleanChannelName, formatTranscript, ticketChannelName } from '../src/modules/tickets.js';
import { unescapeTemplate } from '../src/modules/welcome.js';

test('role panel toggles by mode', () => {
  assert.deepEqual(planToggle('normal', [], 'a'), { add: ['a'], remove: [] });
  assert.deepEqual(planToggle('normal', ['a', 'b'], 'a'), { add: [], remove: ['a'] });
  assert.deepEqual(planToggle('unique', ['b', 'c'], 'a'), { add: ['a'], remove: ['b', 'c'] });
  assert.deepEqual(planToggle('unique', ['a'], 'a'), { add: [], remove: ['a'] });
  assert.deepEqual(planToggle('add-only', ['a'], 'a'), { add: [], remove: [] });
  assert.deepEqual(planToggle('add-only', [], 'a'), { add: ['a'], remove: [] });
});

test('buttons go 5 per row', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7]).map((r) => r.length), [5, 2]);
  assert.equal(chunk([]).length, 0);
});

test('emoji check', () => {
  assert.ok(looksLikeEmoji('🎮'));
  assert.ok(looksLikeEmoji('<:pog:123456789012345678>'));
  assert.ok(!looksLikeEmoji('hello'));
});

test('ticket channel names', () => {
  assert.equal(ticketChannelName(3, 'Cool.User'), 'ticket-3-cooluser');
  assert.equal(ticketChannelName(12, '...'), 'ticket-12');
  assert.equal(cleanChannelName('  Billing Issue!! '), 'billing-issue');
});

test('transcript lists messages with attachments', () => {
  const txt = formatTranscript(['Ticket #1'], [
    { author: 'amy', authorId: '1', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), content: 'hi\nthere', attachments: ['https://x/y.png'] },
  ]);
  assert.match(txt, /\[2026-01-02 03:04:05 UTC\] amy \(1\)/);
  assert.match(txt, /  there/);
  assert.match(txt, /\[attachment\] https:\/\/x\/y\.png/);
});

test('welcome templates turn \\n into new lines', () => {
  assert.equal(unescapeTemplate(' hi\\nthere '), 'hi\nthere');
});
