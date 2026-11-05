import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  automodDefaults,
  blockedLinks,
  capsPercent,
  checkContent,
  countMentions,
  findBadWord,
  findInviteCodes,
  normalizeLeet,
  RepeatTracker,
  type AutomodConfig,
} from '../src/modules/automod.js';

const cfg = (patch: (c: AutomodConfig) => void) => {
  const c = structuredClone(automodDefaults);
  patch(c);
  return c;
};

test('only invites and mentions start on', () => {
  const on = Object.entries(automodDefaults.filters).filter(([, f]) => f.on).map(([id]) => id);
  assert.deepEqual(on.sort(), ['invites', 'mentions']);
});

test('findInviteCodes', () => {
  assert.deepEqual(findInviteCodes('join discord.gg/abc123 or https://discord.com/invite/XyZ'), ['abc123', 'XyZ']);
  assert.deepEqual(findInviteCodes('https://discordapp.com/invite/old'), ['old']);
  assert.deepEqual(findInviteCodes('discord.com/channels/1/2'), []);
});

test('blockedLinks respects the allowlist and skips invites', () => {
  assert.deepEqual(blockedLinks('https://youtube.com/x and https://evil.example/y', ['youtube.com']), ['evil.example']);
  assert.deepEqual(blockedLinks('https://m.youtube.com/x', ['youtube.com']), []);
  assert.deepEqual(blockedLinks('discord.gg/abc', []), []);
  assert.deepEqual(blockedLinks('no links here.', []), []);
});

test('countMentions counts unique users and roles', () => {
  assert.equal(countMentions('<@123456789012345678> <@!123456789012345678> <@&123456789012345678> <@222222222222222222>'), 3);
  assert.equal(countMentions('hello'), 0);
});

test('findBadWord matches whole words with leetspeak', () => {
  const words = ['heck', 'bad phrase'];
  assert.equal(findBadWord('what the HECK', words), 'heck');
  assert.equal(findBadWord('what the h3ck!', words), 'heck');
  assert.equal(findBadWord('such a  bad   phrase', words), 'bad phrase');
  assert.equal(findBadWord('checkmate', words), null);
  assert.equal(findBadWord('hecking', words), null);
  assert.equal(findBadWord('anything', []), null);
  assert.equal(normalizeLeet('$h1t 4 y0u'), 'shit a you');
});

test('capsPercent ignores mentions, emoji and links', () => {
  assert.deepEqual(capsPercent('HELLO there'), { letters: 10, percent: 50 });
  assert.equal(capsPercent('<@123456789012345678> <:EMOJI:123> hi').percent, 0);
  assert.equal(capsPercent('1234 !!!').letters, 0);
});

test('checkContent applies the text filters', () => {
  assert.equal(checkContent('hello', automodDefaults), null);
  const pings = Array.from({ length: 5 }, (_, n) => `<@10000000000000000${n}>`).join(' ');
  assert.equal(checkContent(pings, automodDefaults)?.filter, 'mentions');
  const caps = cfg((c) => (c.filters.caps.on = true));
  assert.equal(checkContent('THIS IS VERY LOUD', caps)?.filter, 'caps');
  assert.equal(checkContent('OK FINE', caps), null);
  const links = cfg((c) => {
    c.filters.links.on = true;
    c.allowedDomains = ['github.com'];
  });
  assert.equal(checkContent('https://github.com/x', links), null);
  assert.equal(checkContent('https://sketchy.site/x', links)?.filter, 'links');
  const words = cfg((c) => {
    c.filters.words.on = true;
    c.words = ['heck'];
  });
  assert.equal(checkContent('h3ck', words)?.filter, 'words');
});

test('RepeatTracker fires on the Nth identical message', () => {
  const r = new RepeatTracker();
  assert.equal(r.add('k', 'Hi', '1', 0, 60_000, 3), null);
  assert.equal(r.add('k', 'hi ', '2', 1000, 60_000, 3), null);
  assert.deepEqual(r.add('k', 'hi', '3', 2000, 60_000, 3), ['1', '2', '3']);
  assert.equal(r.add('k', 'hi', '4', 3000, 60_000, 3), null);
  assert.equal(r.add('k', 'other', '5', 4000, 60_000, 3), null);
  assert.equal(r.add('k', 'other', '6', 200_000, 60_000, 2), null);
});
