import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectScam, editDistance, extractHosts, scamDomain, SlidingWindow } from '../src/modules/security.js';

test('real Discord and Steam domains are not flagged', () => {
  for (const h of ['discord.com', 'discord.gg', 'discord.gift', 'discordapp.com', 'cdn.discordapp.com', 'ptb.discord.com', 'steamcommunity.com', 'steampowered.com', 'store.steampowered.com', 'help.steampowered.com', 'www.steamcommunity.com']) {
    assert.equal(scamDomain(h), null, h);
  }
});

test('ordinary sites are not flagged', () => {
  for (const h of ['google.com', 'youtube.com', 'github.com', 'discord.js.org', 'disboard.org', 'top.gg', 'stream.com', 'steamdb.info', 'steamgifts.com', 'discogs.com', 'mydiscord.net']) {
    assert.equal(scamDomain(h), null, h);
  }
});

test('lookalike domains are flagged', () => {
  for (const h of ['dlscord.com', 'discorcl.gift', 'disc0rd.gg', 'dicsord.com', 'discrod.gift', 'steamcommunlty.com', 'stearncommunity.com', 'steamcomminuty.ru', 'steampowerd.com', 'discord-nitro.com', 'discordgift.site', 'discord.gifts', 'discord-app.com', 'discord.com.ru', 'steam-community.com', 'steamcommunity.ru', 'free-steam-gift.xyz']) {
    assert.notEqual(scamDomain(h), null, h);
  }
});

test('extractHosts finds links with and without https', () => {
  assert.deepEqual(extractHosts('see https://www.Example.com/x and dlscord.gift/abc'), ['example.com', 'dlscord.gift']);
  assert.deepEqual(extractHosts('open index.js or e.g. this'), []);
});

test('detectScam', () => {
  assert.match(detectScam('Free nitro here https://dlscord.gift/xyz')!, /Scam link/);
  assert.match(detectScam('FREE NITRO for everyone! https://bit.ly/abc')!, /Nitro/);
  assert.equal(detectScam('here is my gift https://discord.gift/abc123'), null);
  assert.equal(detectScam('free nitro? no links though'), null);
  assert.match(detectScam('@everyone check https://example.com', 2 * 86400e3)!, /new account/);
  assert.equal(detectScam('@everyone check https://example.com', 60 * 86400e3), null);
  assert.equal(detectScam('look https://youtube.com/watch?v=1'), null);
});

test('editDistance counts swaps as one edit', () => {
  assert.equal(editDistance('discord', 'dicsord'), 1);
  assert.equal(editDistance('discord', 'discord'), 0);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('SlidingWindow drops old hits and stays bounded', () => {
  const w = new SlidingWindow(2, 3);
  w.add('a', 0, 1000);
  w.add('a', 500, 1000);
  assert.equal(w.add('a', 1200, 1000).length, 2);
  for (let t = 0; t < 10; t++) w.add('b', 2000 + t, 1000);
  assert.equal(w.add('b', 2011, 1000).length, 3);
  w.add('c', 3000, 1000);
  assert.equal(w.size, 2);
  w.prune(10_000, 1000);
  assert.equal(w.size, 0);
});
