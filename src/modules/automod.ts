import { ChannelType, Events, type GuildMember, type Message, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getSettings, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, fmtDuration, ok, respond, truncate } from '../util.js';
import { modDefaults, openCase, warnUser } from './moderation.js';
import { detectScam, extractHosts, securityDefaults, SlidingWindow } from './security.js';

export type FilterId = 'invites' | 'links' | 'mentions' | 'words' | 'spam' | 'duplicates' | 'caps';
export type AutomodAction = 'delete' | 'warn' | 'timeout';

export interface FilterConfig {
  on: boolean;
  action: AutomodAction;
  minutes: number;
  threshold: number;
  seconds: number;
  minLength: number;
}

const f = (on: boolean, extra: Partial<FilterConfig> = {}): FilterConfig => ({ on, action: 'delete', minutes: 10, threshold: 0, seconds: 0, minLength: 0, ...extra });

export const automodDefaults = {
  filters: {
    invites: f(true),
    links: f(false),
    mentions: f(true, { threshold: 5 }),
    words: f(false),
    spam: f(false, { threshold: 5, seconds: 5 }),
    duplicates: f(false, { threshold: 3, seconds: 60 }),
    caps: f(false, { threshold: 70, minLength: 10 }),
  } as Record<FilterId, FilterConfig>,
  words: [] as string[],
  allowedDomains: [] as string[],
  exemptRoles: [] as string[],
  exemptChannels: [] as string[],
};
export type AutomodConfig = typeof automodDefaults;

const FILTERS: Record<FilterId, { label: string; notice: string }> = {
  invites: { label: 'Invite links', notice: 'invite links to other servers aren’t allowed here.' },
  links: { label: 'Links', notice: 'links aren’t allowed here.' },
  mentions: { label: 'Mass mentions', notice: 'please don’t mention that many people at once.' },
  words: { label: 'Blocked words', notice: 'that word isn’t allowed here.' },
  spam: { label: 'Spam', notice: 'slow down a little.' },
  duplicates: { label: 'Repeated messages', notice: 'please don’t keep sending the same thing.' },
  caps: { label: 'Too many caps', notice: 'please ease up on the caps.' },
};
const IDS = Object.keys(FILTERS) as FilterId[];

// getSettings only merges one level deep, so patch up filters saved by older versions
export function loadAutomod(db: DB, guildId: string): AutomodConfig {
  const cfg = getSettings(db, guildId, 'automod', automodDefaults);
  const filters = {} as Record<FilterId, FilterConfig>;
  for (const id of IDS) filters[id] = { ...automodDefaults.filters[id], ...cfg.filters?.[id] };
  return { ...cfg, filters };
}

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|discord\.io|dsc\.gg)\/([a-z0-9-]{2,32})/gi;

export function findInviteCodes(content: string): string[] {
  return [...new Set([...content.matchAll(INVITE_RE)].map((m) => m[1]))];
}

export function blockedLinks(content: string, allowed: string[]): string[] {
  // invites have their own filter
  const hosts = extractHosts(content.replace(INVITE_RE, ' '));
  const allow = allowed.map((d) => d.toLowerCase());
  return hosts.filter((h) => !allow.some((d) => h === d || h.endsWith(`.${d}`)));
}

export function countMentions(content: string): number {
  const ids = new Set<string>();
  for (const m of content.matchAll(/<@(!|&)?(\d{15,25})>/g)) ids.add(`${m[1] === '&' ? 'r' : 'u'}${m[2]}`);
  return ids.size;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't' };

export function normalizeLeet(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ​-‍﻿]/g, '')
    .toLowerCase()
    .replace(/[0134578@$!|+]/g, (c) => LEET[c]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findBadWord(content: string, words: string[]): string | null {
  if (!words.length) return null;
  const plain = content.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');
  // try with and without leetspeak on trailing punctuation, "h3ck!" shouldn't become "hecki"
  const variants = [plain, normalizeLeet(content), normalizeLeet(content.replace(/[!|+@$]+(?=\s|$)/g, ''))].map((v) => v.replace(/\s+/g, ' '));
  for (const w of words) {
    const word = w.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!word) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'u');
    if (variants.some((v) => re.test(v))) return word;
  }
  return null;
}

export function capsPercent(content: string): { letters: number; percent: number } {
  const text = content.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '');
  let letters = 0;
  let upper = 0;
  for (const ch of text) {
    if (ch.toLowerCase() === ch.toUpperCase()) continue;
    letters++;
    if (ch === ch.toUpperCase()) upper++;
  }
  return { letters, percent: letters ? Math.round((upper / letters) * 100) : 0 };
}

export interface Hit {
  filter: FilterId;
  detail: string;
}

// stateless filters only, scan() handles invites/spam/repeats
export function checkContent(content: string, cfg: AutomodConfig): Hit | null {
  const fl = cfg.filters;
  if (fl.links.on) {
    const bad = blockedLinks(content, cfg.allowedDomains);
    if (bad.length) return { filter: 'links', detail: bad.join(', ') };
  }
  if (fl.mentions.on && fl.mentions.threshold > 0) {
    const n = countMentions(content);
    if (n >= fl.mentions.threshold) return { filter: 'mentions', detail: `${n} mentions` };
  }
  if (fl.words.on) {
    const w = findBadWord(content, cfg.words);
    if (w) return { filter: 'words', detail: `matched "${w}"` };
  }
  if (fl.caps.on) {
    const c = capsPercent(content);
    if (c.letters >= fl.caps.minLength && c.percent >= fl.caps.threshold) return { filter: 'caps', detail: `${c.percent}% caps` };
  }
  return null;
}

export class RepeatTracker {
  private last = new Map<string, { text: string; at: number; ids: string[] }>();
  constructor(private maxKeys = 5000) {}

  add(key: string, text: string, id: string, now: number, windowMs: number, times: number): string[] | null {
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm) return null;
    const prev = this.last.get(key);
    const ids = prev && prev.text === norm && now - prev.at < windowMs ? [...prev.ids.slice(-20), id] : [id];
    this.last.delete(key);
    this.last.set(key, { text: norm, at: now, ids });
    if (this.last.size > this.maxKeys) this.last.delete(this.last.keys().next().value!);
    if (ids.length < times) return null;
    this.last.delete(key);
    return ids;
  }
  prune(now: number, maxAge: number) {
    for (const [k, v] of this.last) if (now - v.at > maxAge) this.last.delete(k);
  }
}

const spam = new SlidingWindow(5000, 50);
const repeats = new RepeatTracker();
const inviteGuilds = new Map<string, { guildId: string | null; at: number }>();
const lastPunished = new Map<string, number>();
const lastNotice = new Map<string, number>();

async function inviteIsForeign(ctx: Ctx, msg: Message<true>, code: string) {
  if (msg.guild.vanityURLCode && code.toLowerCase() === msg.guild.vanityURLCode.toLowerCase()) return false;
  let hit = inviteGuilds.get(code);
  if (!hit || Date.now() - hit.at > 3600e3) {
    const inv = await ctx.client.fetchInvite(code).catch(() => null);
    hit = { guildId: inv?.guild?.id ?? null, at: Date.now() };
    inviteGuilds.set(code, hit);
    if (inviteGuilds.size > 2000) inviteGuilds.delete(inviteGuilds.keys().next().value!);
  }
  return hit.guildId !== msg.guildId;
}

function isExempt(msg: Message<true>, member: GuildMember, cfg: AutomodConfig) {
  if (member.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageMessages)) return true;
  const parent = msg.channel.isThread() ? msg.channel.parentId : null;
  if (cfg.exemptChannels.includes(msg.channelId) || (parent && cfg.exemptChannels.includes(parent))) return true;
  return member.roles.cache.some((r) => cfg.exemptRoles.includes(r.id));
}

async function punish(ctx: Ctx, msg: Message<true>, member: GuildMember, hit: Hit, rule: FilterConfig, ids: string[] = [msg.id]) {
  const { guild } = msg;
  const canDelete = guild.members.me?.permissionsIn(msg.channel).has(PermissionFlagsBits.ManageMessages);
  if (canDelete) {
    if (ids.length > 1 && 'bulkDelete' in msg.channel) await msg.channel.bulkDelete(ids, true).catch(() => {});
    else await msg.delete().catch(() => {});
  }

  const key = `${guild.id}:${member.id}`;
  const now = Date.now();
  // one punishment per burst or a spam wave racks up 5 warnings
  const fresh = now - (lastPunished.get(key) ?? 0) > 15e3;
  let outcome = canDelete ? 'Deleted' : 'Couldn’t delete (missing Manage Messages)';
  const reason = `Automod: ${FILTERS[hit.filter].label.toLowerCase()} (${hit.detail})`;
  if (fresh && rule.action === 'warn') {
    lastPunished.set(key, now);
    const { c } = await warnUser(ctx, guild, member.user, ctx.client.user.id, reason);
    outcome += `, warned (case #${c.num})`;
  } else if (fresh && rule.action === 'timeout') {
    lastPunished.set(key, now);
    const ms = rule.minutes * 60e3;
    if (member.moderatable && (await member.timeout(ms, reason).then(() => true, () => false))) {
      if (getSettings(ctx.db, guild.id, 'moderation', modDefaults).dmUsers) {
        await member.send({ embeds: [embed(colors.warning).setTitle(`You were timed out in ${guild.name}`).setDescription(`**Reason:** ${reason}\n**Length:** ${fmtDuration(ms)}`)] }).catch(() => {});
      }
      const c = await openCase(ctx, guild, { action: 'timeout', user: member.user, modId: ctx.client.user.id, reason, durationMs: ms });
      outcome += `, timed out for ${fmtDuration(ms)} (case #${c.num})`;
    } else outcome += ', couldn’t time them out';
  }

  if (now - (lastNotice.get(key) ?? 0) > 5e3) {
    lastNotice.set(key, now);
    const note = await msg.channel.send({ content: `<@${member.id}>, ${FILTERS[hit.filter].notice}`, allowedMentions: { users: [member.id] } }).catch(() => null);
    if (note) setTimeout(() => note.delete().catch(() => {}), 5000);
  }

  await ctx.log(
    guild,
    'security',
    embed(colors.warning)
      .setTitle(`🛡️ Automod: ${FILTERS[hit.filter].label}`)
      .setDescription(truncate(msg.content || '*no text*', 1500))
      .addFields(
        { name: 'User', value: `<@${member.id}> (${member.user.tag})`, inline: true },
        { name: 'Channel', value: `<#${msg.channelId}>`, inline: true },
        { name: 'Why', value: truncate(hit.detail, 1024) },
        { name: 'Action', value: outcome },
      ),
  );
}

async function scan(ctx: Ctx, msg: Message<true>, edited: boolean) {
  if (msg.author.bot || msg.webhookId || !msg.content) return;
  const cfg = loadAutomod(ctx.db, msg.guildId);
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member || isExempt(msg, member, cfg)) return;

  // security handles scam links
  if (ctx.enabled(msg.guildId, 'security') && getSettings(ctx.db, msg.guildId, 'security', securityDefaults).scamOn && detectScam(msg.content, Date.now() - msg.author.createdTimestamp)) return;

  const fl = cfg.filters;
  if (fl.invites.on) {
    for (const code of findInviteCodes(msg.content)) {
      if (await inviteIsForeign(ctx, msg, code)) return punish(ctx, msg, member, { filter: 'invites', detail: `discord.gg/${code}` }, fl.invites);
    }
  }
  const hit = checkContent(msg.content, cfg);
  if (hit) return punish(ctx, msg, member, hit, fl[hit.filter]);
  if (edited) return;

  const key = `${msg.guildId}:${msg.author.id}`;
  const now = Date.now();
  if (fl.spam.on && fl.spam.threshold > 0) {
    const recent = spam.add(key, now, fl.spam.seconds * 1000, msg.id);
    if (recent.length >= fl.spam.threshold) {
      spam.clear(key);
      return punish(ctx, msg, member, { filter: 'spam', detail: `${recent.length} messages in ${fl.spam.seconds}s` }, fl.spam, recent.map((r) => r.v));
    }
  }
  if (fl.duplicates.on && fl.duplicates.threshold > 1) {
    const ids = repeats.add(`${key}:${msg.channelId}`, msg.content, msg.id, now, fl.duplicates.seconds * 1000, fl.duplicates.threshold);
    if (ids) return punish(ctx, msg, member, { filter: 'duplicates', detail: `sent the same message ${ids.length} times` }, fl.duplicates, ids);
  }
}

const command = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Automatic filters for invites, links, spam and more')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName('show').setDescription('Show every filter and how it’s set up'))
  .addSubcommand((s) =>
    s
      .setName('filter')
      .setDescription('Turn a filter on or off and choose what it does')
      .addStringOption((o) =>
        o
          .setName('filter')
          .setDescription('Which filter')
          .setRequired(true)
          .addChoices(...IDS.map((id) => ({ name: FILTERS[id].label, value: id }))),
      )
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('What happens when it catches something')
          .addChoices({ name: 'Delete the message', value: 'delete' }, { name: 'Delete and warn', value: 'warn' }, { name: 'Delete and time out', value: 'timeout' }),
      )
      .addIntegerOption((o) => o.setName('threshold').setDescription('Mentions: how many. Spam: messages. Repeats: times. Caps: percent').setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName('seconds').setDescription('Spam and repeats: the time window in seconds').setMinValue(2).setMaxValue(600))
      .addIntegerOption((o) => o.setName('min_length').setDescription('Caps: only check messages with at least this many letters').setMinValue(1).setMaxValue(500))
      .addIntegerOption((o) => o.setName('timeout_minutes').setDescription('How long the timeout lasts').setMinValue(1).setMaxValue(40320)),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('words')
      .setDescription('The blocked words list')
      .addSubcommand((s) => s.setName('add').setDescription('Block words (separate several with commas)').addStringOption((o) => o.setName('words').setDescription('e.g. word1, word2').setRequired(true).setMaxLength(1000)))
      .addSubcommand((s) => s.setName('remove').setDescription('Unblock words (separate several with commas)').addStringOption((o) => o.setName('words').setDescription('e.g. word1, word2').setRequired(true).setMaxLength(1000)))
      .addSubcommand((s) => s.setName('list').setDescription('Show the blocked words')),
  )
  .addSubcommandGroup((g) =>
    g
      .setName('allow-domain')
      .setDescription('Sites the link filter lets through')
      .addSubcommand((s) => s.setName('add').setDescription('Allow a site').addStringOption((o) => o.setName('domain').setDescription('e.g. youtube.com').setRequired(true).setMaxLength(100)))
      .addSubcommand((s) => s.setName('remove').setDescription('Stop allowing a site').addStringOption((o) => o.setName('domain').setDescription('e.g. youtube.com').setRequired(true).setMaxLength(100))),
  )
  .addSubcommand((s) =>
    s
      .setName('exempt')
      .setDescription('Let a role or channel skip automod (run again to undo)')
      .addRoleOption((o) => o.setName('role').setDescription('Role to toggle'))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to toggle').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice)),
  );

const ACTION_TEXT: Record<AutomodAction, string> = { delete: 'delete', warn: 'delete + warn', timeout: 'delete + timeout' };

function describe(id: FilterId, r: FilterConfig) {
  const extra =
    id === 'mentions' ? `${r.threshold}+ people` : id === 'spam' ? `${r.threshold} messages in ${r.seconds}s` : id === 'duplicates' ? `${r.threshold} times in ${r.seconds}s` : id === 'caps' ? `${r.threshold}%+ caps, ${r.minLength}+ letters` : '';
  const action = r.action === 'timeout' ? `${ACTION_TEXT.timeout} (${fmtDuration(r.minutes * 60e3)})` : ACTION_TEXT[r.action];
  return `${r.on ? '🟢' : '⚫'} **${FILTERS[id].label}**${r.on ? `: ${action}${extra ? `, ${extra}` : ''}` : ' (off)'}`;
}

const splitList = (s: string) => [...new Set(s.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))];

export const automodModule: Module = {
  id: 'automod',
  name: 'Automod',
  description: 'Filters invites, links, mass mentions, blocked words, spam, repeated messages and caps.',
  defaultOn: true,
  commands: [command.toJSON()],
  handle: {
    async automod(i, { db }) {
      const group = i.options.getSubcommandGroup();
      const sub = i.options.getSubcommand();
      const cfg = loadAutomod(db, i.guildId);
      const save = (patch: Partial<AutomodConfig>) => setSettings(db, i.guildId, 'automod', automodDefaults, patch);

      if (group === 'words') {
        if (sub === 'list') {
          return respond(i, { embeds: [embed().setTitle('Blocked words').setDescription(cfg.words.length ? truncate(cfg.words.map((w) => `||${w}||`).join(', '), 4000) : 'None yet. Add some with `/automod words add`.')] });
        }
        const given = splitList(i.options.getString('words', true));
        if (sub === 'add') {
          const words = [...new Set([...cfg.words, ...given])].slice(0, 500);
          save({ words });
          return ok(i, `Blocked ${given.length} word(s). The list has ${words.length} now.${cfg.filters.words.on ? '' : ' Turn the filter on with `/automod filter`.'}`);
        }
        save({ words: cfg.words.filter((w) => !given.includes(w)) });
        return ok(i, 'Updated the blocked words list.');
      }

      if (group === 'allow-domain') {
        const domain = i.options.getString('domain', true).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return fail(i, 'That doesn’t look like a domain. Try something like `youtube.com`.');
        if (sub === 'add') {
          save({ allowedDomains: [...new Set([...cfg.allowedDomains, domain])] });
          return ok(i, `Links to **${domain}** are allowed.`);
        }
        save({ allowedDomains: cfg.allowedDomains.filter((d) => d !== domain) });
        return ok(i, `Links to **${domain}** aren’t allowed any more.`);
      }

      if (sub === 'filter') {
        const id = i.options.getString('filter', true) as FilterId;
        const r = { ...cfg.filters[id] };
        const on = i.options.getBoolean('enabled');
        const action = i.options.getString('action') as AutomodAction | null;
        const threshold = i.options.getInteger('threshold');
        const seconds = i.options.getInteger('seconds');
        const minLength = i.options.getInteger('min_length');
        const minutes = i.options.getInteger('timeout_minutes');
        if (on !== null) r.on = on;
        if (action) r.action = action;
        if (threshold !== null) r.threshold = threshold;
        if (seconds !== null) r.seconds = seconds;
        if (minLength !== null) r.minLength = minLength;
        if (minutes !== null) r.minutes = minutes;
        save({ filters: { ...cfg.filters, [id]: r } });
        let tip = '';
        if (r.on && id === 'words' && !cfg.words.length) tip = '\nThe word list is empty, add some with `/automod words add`.';
        if (r.on && id === 'links' && !cfg.allowedDomains.length) tip = '\nEvery link gets blocked until you allow some sites with `/automod allow-domain add`.';
        return ok(i, `${describe(id, r)}${tip}`);
      }

      if (sub === 'exempt') {
        const role = i.options.getRole('role');
        const ch = i.options.getChannel('channel');
        if (!role && !ch) return fail(i, 'Pick a role, a channel, or both.');
        const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
        const next = save({
          exemptRoles: role ? toggle(cfg.exemptRoles, role.id) : cfg.exemptRoles,
          exemptChannels: ch ? toggle(cfg.exemptChannels, ch.id) : cfg.exemptChannels,
        });
        const lines: string[] = [];
        if (role) lines.push(`<@&${role.id}> ${next.exemptRoles.includes(role.id) ? 'now skips automod' : 'is checked by automod again'}.`);
        if (ch) lines.push(`<#${ch.id}> ${next.exemptChannels.includes(ch.id) ? 'now skips automod' : 'is checked by automod again'}.`);
        return ok(i, lines.join('\n'));
      }

      const lines = IDS.map((id) => describe(id, cfg.filters[id]));
      lines.push(
        '',
        `**Blocked words:** ${cfg.words.length}`,
        `**Allowed sites:** ${cfg.allowedDomains.length ? cfg.allowedDomains.join(', ') : 'none'}`,
        `**Skips automod:** ${[...cfg.exemptRoles.map((r) => `<@&${r}>`), ...cfg.exemptChannels.map((c) => `<#${c}>`)].join(', ') || 'nobody extra'}`,
        '-# Bots and anyone with Manage Messages are never checked.',
      );
      return respond(i, { embeds: [embed().setTitle('Automod').setDescription(lines.join('\n'))] });
    },
  },

  init(ctx) {
    ctx.client.on(Events.MessageCreate, async (msg) => {
      try {
        if (!msg.inGuild() || !ctx.enabled(msg.guildId, 'automod')) return;
        await scan(ctx, msg, false);
      } catch (e) {
        console.warn('[automod]', e instanceof Error ? e.message : e);
      }
    });
    ctx.client.on(Events.MessageUpdate, async (before, after) => {
      try {
        if (after.partial || !after.inGuild() || before.content === after.content) return;
        if (!ctx.enabled(after.guildId, 'automod')) return;
        await scan(ctx, after, true);
      } catch (e) {
        console.warn('[automod] edit:', e instanceof Error ? e.message : e);
      }
    });
  },

  async tick() {
    const now = Date.now();
    spam.prune(now, 600e3);
    repeats.prune(now, 600e3);
    for (const m of [lastPunished, lastNotice]) for (const [k, t] of m) if (now - t > 60e3) m.delete(k);
  },
};
