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

test('ticket tracker card', async () => {
  const { trackerEmbed } = await import('../src/modules/tickets.js');
  const hour = 3_600_000;
  const t = { id: 1, guild_id: 'g', num: 7, channel_id: '99', opener_id: 'a', reason: '', claimed_by: 'b', claimed_at: hour, status: 'closed' as const, created_at: 0, closed_at: 3 * hour, closed_by: 'b', close_reason: null };
  const msg = (id: string, bot = false) => ({ author: { id, bot } }) as never;
  const e = trackerEmbed(t, { name: 'ticket-7-sam', type: 'Support', closerId: 'b', reason: 'sorted', closedAt: 3 * hour, history: [msg('a'), msg('a'), msg('b'), msg('bot', true)] }).toJSON();
  const field = (n: string) => e.fields!.find((f) => f.name.startsWith(n))!.value;
  assert.equal(field('Time to claim'), '1h');
  assert.equal(field('Handled for'), '2h');
  assert.equal(field('Open for'), '3h');
  assert.match(field('Members involved'), /<@a> · 2 messages \(opener\)/);
  assert.match(field('Members involved'), /<@b> · 1 message \(claimed, closed\)/);
  assert.equal(field('Members involved').includes('bot'), false);
});
