import {
  MessageFlags,
  AuditLogEvent,
  ChannelType,
  Events,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type NewsChannel,
  OverwriteType,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  type TextChannel,
} from 'discord.js';
import { all, get, getSettings, run, setSettings } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, fmtDuration, ok, respond, truncate, ts } from '../util.js';
import { openCase } from './moderation.js';

type RaidAction = 'kick' | 'timeout' | 'alert';
type NukeAction = 'strip' | 'ban';

export const securityDefaults = {
  raidOn: true,
  raidJoins: 10,
  raidSeconds: 10,
  raidMinutes: 10,
  raidAction: 'kick' as RaidAction,
  raidLockdown: false,
  minAccountAgeDays: 0,
  nukeOn: true,
  nukeDeleteLimit: 3,
  nukeBanLimit: 5,
  nukeAction: 'strip' as NukeAction,
  scamOn: true,
  trusted: [] as string[],
};
type SecurityConfig = typeof securityDefaults;

const schema = `
create table if not exists security_lockdown (
  guild_id text not null,
  channel_id text not null,
  had_overwrite integer not null,
  allow text not null default '0',
  deny text not null default '0',
  reason text not null default '',
  source text not null default 'manual',
  started_by text not null,
  started_at integer not null,
  ends_at integer,
  primary key (guild_id, channel_id)
);
`;

interface LockRow {
  guild_id: string;
  channel_id: string;
  had_overwrite: number;
  allow: string;
  deny: string;
  source: string;
  ends_at: number | null;
}

// rolling hit counter, capped so a flood can't eat memory
export class SlidingWindow {
  private hits = new Map<string, { t: number; v: string }[]>();
  constructor(private maxKeys = 5000, private maxPerKey = 200) {}

  add(key: string, now: number, windowMs: number, v = '') {
    const list = (this.hits.get(key) ?? []).filter((h) => now - h.t < windowMs);
    list.push({ t: now, v });
    if (list.length > this.maxPerKey) list.splice(0, list.length - this.maxPerKey);
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return list;
  }
  clear(key: string) {
    this.hits.delete(key);
  }
  prune(now: number, windowMs: number) {
    for (const [k, list] of this.hits) if (!list.length || now - list[list.length - 1].t >= windowMs) this.hits.delete(k);
  }
  get size() {
    return this.hits.size;
  }
}

const COMMON_TLDS = new Set('com net org gg io me co ru xyz gift gifts link site online top info app live shop store club pw cc tk ml ga cf us uk de fr click fun su ws biz'.split(' '));

export function extractHosts(content: string): string[] {
  const out = new Set<string>();
  const re = /(https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/|:\d|\?|#)?/gi;
  for (const m of content.matchAll(re)) {
    const host = m[2].toLowerCase().replace(/^www\./, '');
    const tld = host.slice(host.lastIndexOf('.') + 1);
    if (m[1] || m[3] || COMMON_TLDS.has(tld)) out.add(host);
  }
  return [...out];
}

const DISCORD_OFFICIAL = ['discord.com', 'discord.gg', 'discord.gift', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discord.co', 'discord.dev', 'discord.design', 'discord.store', 'discord.tools', 'discordstatus.com', 'discordcdn.com', 'dis.gd'];
const STEAM_OFFICIAL = ['steamcommunity.com', 'steampowered.com', 'steamstatic.com', 'steamgames.com', 'steamusercontent.com', 'steamcontent.com', 'steamserver.net', 'steam-chat.com', 'steamdeck.com', 'steam.tv', 's.team', 'steamchina.com', 'valvesoftware.com'];
const OFFICIAL = [...DISCORD_OFFICIAL, ...STEAM_OFFICIAL];
// legit sites that would otherwise trip the brand + bait word check
const KNOWN_OK = ['discord.js.org', 'discords.com', 'discordbotlist.com', 'discordservers.com', 'steamgifts.com', 'steamtrades.com', 'steamdb.info', 'steamcharts.com', 'steamspy.com'];

const BRANDS: { name: string; label: string; fuzz: number }[] = [
  { name: 'discord', label: 'Discord', fuzz: 1 },
  { name: 'steamcommunity', label: 'Steam', fuzz: 2 },
  { name: 'steampowered', label: 'Steam', fuzz: 2 },
  { name: 'steam', label: 'Steam', fuzz: 0 },
];
const BAIT = /gift|nitro|free|airdrop|promo|claim|giveaway|login|verify|auth|trade|app|support|reward|bonus|boost|event|offer|skin/;

const sameOrSub = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
export const isOfficialHost = (host: string) => OFFICIAL.some((d) => sameOrSub(host, d));

// undo common lookalike tricks (rn->m, cl->d, 1/i->l, 0->o) so dlscord/discorcl match discord
const skeleton = (s: string) =>
  s
    .replace(/rn/g, 'm')
    .replace(/cl/g, 'd')
    .replace(/vv/g, 'w')
    .replace(/[1i!|]/g, 'l')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/[4@]/g, 'a');

// levenshtein + adjacent swaps count as 1 (dicsord)
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export function scamDomain(rawHost: string): string | null {
  const host = rawHost.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (isOfficialHost(host) || KNOWN_OK.some((d) => sameOrSub(host, d))) return null;

  for (const d of OFFICIAL) if (host.startsWith(`${d}.`) || host.includes(`.${d}.`)) return `pretends to be ${d}`;

  const core = host.includes('.') ? host.slice(0, host.lastIndexOf('.')) : host;
  const joined = core.replace(/[.-]/g, '');
  const labels = core.split(/[.-]/).filter(Boolean);

  for (const b of BRANDS) {
    if (b.fuzz) {
      for (const l of labels) {
        if (l === b.name) continue;
        if (skeleton(l) === skeleton(b.name) || (l.length > 4 && editDistance(l, b.name) <= b.fuzz)) return `lookalike of ${b.label}`;
      }
    }
    if (!skeleton(joined).includes(skeleton(b.name))) continue;
    if (!joined.includes(b.name)) return `lookalike of ${b.label}`;
    if (joined === b.name) return `fake ${b.label} domain`;
    if (BAIT.test(joined.replace(b.name, ''))) return `fake ${b.label} domain`;
  }
  return null;
}

const NITRO_BAIT = /\b(free|gift(ed)?|claim|giveaway)\b[^\n]{0,40}\bnitro\b|\bnitro\b[^\n]{0,40}\b(free|gift|giveaway|claim)\b|\bsteam\b[^\n]{0,30}\b(gift|free|giveaway)\b/i;
const WEEK = 7 * 86400e3;

export function detectScam(content: string, accountAgeMs = Infinity): string | null {
  const hosts = extractHosts(content);
  if (!hosts.length) return null;
  for (const h of hosts) {
    const why = scamDomain(h);
    if (why) return `Scam link (${h}: ${why})`;
  }
  const outside = hosts.some((h) => !isOfficialHost(h));
  if (outside && NITRO_BAIT.test(content)) return 'Free Nitro/Steam bait with a link';
  if (/@(everyone|here)/.test(content) && accountAgeMs < WEEK) return 'Mass ping with a link from a brand new account';
  return null;
}

// in memory only, raid mode just ends on restart
const joins = new SlidingWindow(2000, 500);
const nukeHits = new SlidingWindow(5000, 50);
const raids = new Map<string, { until: number; handled: number }>();
const recentlyPunished = new Map<string, number>();

const cfgFor = (ctx: Ctx, guildId: string) => getSettings<SecurityConfig>(ctx.db, guildId, 'security', securityDefaults);

const LOCK_BITS = PermissionFlagsBits.SendMessages | PermissionFlagsBits.SendMessagesInThreads | PermissionFlagsBits.AddReactions;
type Lockable = TextChannel | NewsChannel | ForumChannel;
const LOCKABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

async function putEveryone(ctx: Ctx, ch: Lockable, allow: bigint, deny: bigint, reason: string) {
  if (!allow && !deny) {
    await ch.permissionOverwrites.delete(ch.guild.id, reason);
    return;
  }
  await ctx.client.rest.put(Routes.channelPermission(ch.id, ch.guild.id), {
    body: { type: OverwriteType.Role, allow: allow.toString(), deny: deny.toString() },
    reason,
  });
}

export async function lockChannels(ctx: Ctx, guild: Guild, channels: Lockable[], opts: { reason: string; by: string; source: 'manual' | 'raid'; endsAt?: number | null }) {
  const me = guild.members.me!;
  let locked = 0;
  let skipped = 0;
  for (const ch of channels) {
    const perms = me.permissionsIn(ch);
    if (!perms.has(PermissionFlagsBits.ManageRoles) || !perms.has(PermissionFlagsBits.ViewChannel)) {
      skipped++;
      continue;
    }
    if (get(ctx.db, 'select 1 from security_lockdown where guild_id = ? and channel_id = ?', guild.id, ch.id)) continue;
    const ow = ch.permissionOverwrites.cache.get(guild.id);
    const allow = ow?.allow.bitfield ?? 0n;
    const deny = ow?.deny.bitfield ?? 0n;
    const notice =
      ch.type !== ChannelType.GuildForum && perms.has(PermissionFlagsBits.SendMessages)
        ? await ch.send({ embeds: [embed(colors.danger).setTitle('🔒 Channel locked').setDescription(opts.reason || 'Staff have locked this channel for now.')] }).catch(() => null)
        : null;
    try {
      await putEveryone(ctx, ch, allow & ~LOCK_BITS, deny | LOCK_BITS, `Lockdown: ${opts.reason || 'no reason'}`);
    } catch {
      await notice?.delete().catch(() => {});
      skipped++;
      continue;
    }
    run(
      ctx.db,
      'insert into security_lockdown (guild_id, channel_id, had_overwrite, allow, deny, reason, source, started_by, started_at, ends_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      guild.id, ch.id, ow ? 1 : 0, allow.toString(), deny.toString(), opts.reason, opts.source, opts.by, Date.now(), opts.endsAt ?? null,
    );
    locked++;
  }
  return { locked, skipped };
}

export async function unlockChannels(ctx: Ctx, guild: Guild, rows: LockRow[]) {
  let done = 0;
  for (const r of rows) {
    const ch = (guild.channels.cache.get(r.channel_id) ?? (await guild.channels.fetch(r.channel_id).catch(() => null))) as Lockable | null;
    if (!ch) {
      run(ctx.db, 'delete from security_lockdown where guild_id = ? and channel_id = ?', guild.id, r.channel_id);
      continue;
    }
    // only restore the perms we touched
    const ow = ch.permissionOverwrites.cache.get(guild.id);
    const allow = ((ow?.allow.bitfield ?? 0n) & ~LOCK_BITS) | (BigInt(r.allow) & LOCK_BITS);
    const deny = ((ow?.deny.bitfield ?? 0n) & ~LOCK_BITS) | (BigInt(r.deny) & LOCK_BITS);
    try {
      await putEveryone(ctx, ch, allow, deny, 'Lockdown ended');
    } catch (e) {
      console.warn(`[security] couldn't unlock ${ch.id}:`, e instanceof Error ? e.message : e);
      continue;
    }
    run(ctx.db, 'delete from security_lockdown where guild_id = ? and channel_id = ?', guild.id, r.channel_id);
    if (ch.type !== ChannelType.GuildForum) await ch.send({ embeds: [embed(colors.success).setTitle('🔓 Channel unlocked').setDescription('You can chat here again.')] }).catch(() => {});
    done++;
  }
  return done;
}

const textChannels = (guild: Guild) =>
  [...guild.channels.cache.values()].filter(
    (c): c is Lockable => LOCKABLE.includes(c.type) && !!guild.roles.everyone.permissionsIn(c as Lockable).has(PermissionFlagsBits.ViewChannel),
  );

async function startRaid(ctx: Ctx, guild: Guild, cfg: SecurityConfig, recent: string[]) {
  const until = Date.now() + cfg.raidMinutes * 60e3;
  raids.set(guild.id, { until, handled: 0 });
  let lockNote = '';
  if (cfg.raidLockdown) {
    const { locked } = await lockChannels(ctx, guild, textChannels(guild), { reason: 'Raid protection: the server is locked for a few minutes.', by: ctx.client.user.id, source: 'raid', endsAt: until });
    lockNote = `\nLocked **${locked}** channel(s) until raid mode ends.`;
  }
  await ctx.log(
    guild,
    'security',
    embed(colors.danger)
      .setTitle('🚨 Raid detected')
      .setDescription(
        `More than **${cfg.raidJoins}** people joined in **${cfg.raidSeconds}s**. Raid mode is on until ${ts(until, 't')} (${ts(until, 'R')}).\n` +
          `New joiners will be: **${cfg.raidAction === 'alert' ? 'left alone (alert only)' : cfg.raidAction === 'kick' ? 'kicked' : 'timed out'}**.${lockNote}\n` +
          'End it early with `/security end-raid`.',
      ),
  );
  for (const id of recent) {
    const m = guild.members.cache.get(id);
    if (m) await handleRaider(ctx, m, cfg);
  }
}

async function handleRaider(ctx: Ctx, m: GuildMember, cfg: SecurityConfig) {
  const raid = raids.get(m.guild.id);
  if (!raid || cfg.raidAction === 'alert') return;
  if (cfg.raidAction === 'kick' && m.kickable) {
    await m.send(`**${m.guild.name}** is in raid protection mode right now, so new joins are paused. Please try again in a few minutes.`).catch(() => {});
    if (await m.kick('Raid protection').then(() => true, () => false)) raid.handled++;
  } else if (cfg.raidAction === 'timeout' && m.moderatable) {
    if (await m.timeout(60 * 60e3, 'Raid protection').then(() => true, () => false)) raid.handled++;
  }
}

async function endRaid(ctx: Ctx, guild: Guild, early = false) {
  const raid = raids.get(guild.id);
  raids.delete(guild.id);
  const rows = all<LockRow>(ctx.db, "select * from security_lockdown where guild_id = ? and source = 'raid'", guild.id);
  const unlocked = rows.length ? await unlockChannels(ctx, guild, rows) : 0;
  if (!raid) return false;
  await ctx.log(
    guild,
    'security',
    embed(colors.success)
      .setTitle('✅ Raid mode ended')
      .setDescription(`${early ? 'Ended by staff. ' : ''}Dealt with **${raid.handled}** joiner(s).${unlocked ? ` Unlocked **${unlocked}** channel(s).` : ''}`),
  );
  return true;
}

async function onNukeAction(ctx: Ctx, guild: Guild, executorId: string, bucket: 'destroy' | 'ban', what: string) {
  const cfg = cfgFor(ctx, guild.id);
  if (!cfg.nukeOn) return;
  if (executorId === guild.ownerId || executorId === ctx.client.user.id || cfg.trusted.includes(executorId)) return;
  const key = `${guild.id}:${executorId}`;
  const list = nukeHits.add(`${key}:${bucket}`, Date.now(), 60e3, what);
  const limit = bucket === 'destroy' ? cfg.nukeDeleteLimit : cfg.nukeBanLimit;
  if (list.length <= limit) return;
  if (Date.now() - (recentlyPunished.get(key) ?? 0) < 60e3) return;
  recentlyPunished.set(key, Date.now());
  nukeHits.clear(`${key}:${bucket}`);

  const member = await guild.members.fetch(executorId).catch(() => null);
  let result = 'I couldn’t find them in the server.';
  if (member) {
    if (cfg.nukeAction === 'ban' && member.bannable) {
      await guild.members.ban(executorId, { reason: 'Anti-nuke: too many destructive actions' }).then(
        () => (result = 'Banned them.'),
        () => (result = 'I tried to ban them but couldn’t.'),
      );
      if (result === 'Banned them.') await openCase(ctx, guild, { action: 'ban', user: member.user, modId: ctx.client.user.id, reason: `Anti-nuke: ${list.length} ${what} in a minute` });
    } else if (member.user.bot && member.kickable) {
      await member.kick('Anti-nuke').then(
        () => (result = 'Kicked the bot.'),
        () => (result = 'I tried to kick the bot but couldn’t.'),
      );
    } else if (member.manageable) {
      await member.roles.set(member.roles.cache.filter((r) => r.managed).map((r) => r.id), 'Anti-nuke: too many destructive actions').then(
        () => (result = 'Removed all their roles.'),
        () => (result = 'I tried to remove their roles but couldn’t.'),
      );
      await openCase(ctx, guild, { action: 'note', user: member.user, modId: ctx.client.user.id, reason: `Anti-nuke: roles removed after ${list.length} ${what} in a minute` });
    } else {
      result = 'Their top role is above mine, so I couldn’t do anything. Move my role higher.';
    }
  }
  await ctx.log(
    guild,
    'security',
    embed(colors.danger)
      .setTitle('🚨 Possible nuke')
      .setDescription(`<@${executorId}> did **${list.length}** ${what} in under a minute (limit ${limit}).\n**Action:** ${result}`)
      .setFooter({ text: 'Trust someone with /security trust add if this was expected.' }),
  );
}

const isOwner = (ctx: Ctx, guild: Guild, userId: string) => userId === guild.ownerId || ctx.config.ownerIds.includes(userId);

const commands = [
  new SlashCommandBuilder()
    .setName('security')
    .setDescription('Raid, nuke and scam protection')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('show').setDescription('Show the current security settings'))
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Change security settings')
        .addBooleanOption((o) => o.setName('raid_protection').setDescription('Watch for lots of joins at once'))
        .addIntegerOption((o) => o.setName('raid_joins').setDescription('Raid when more than this many people join...').setMinValue(3).setMaxValue(100))
        .addIntegerOption((o) => o.setName('raid_seconds').setDescription('...within this many seconds').setMinValue(5).setMaxValue(300))
        .addIntegerOption((o) => o.setName('raid_minutes').setDescription('How long raid mode lasts').setMinValue(1).setMaxValue(240))
        .addStringOption((o) =>
          o.setName('raid_action').setDescription('What happens to people who join during raid mode').addChoices(
            { name: 'Kick them', value: 'kick' },
            { name: 'Time them out for an hour', value: 'timeout' },
            { name: 'Nothing, just alert', value: 'alert' },
          ),
        )
        .addBooleanOption((o) => o.setName('raid_lockdown').setDescription('Lock all text channels during raid mode'))
        .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Kick accounts younger than this many days (0 = off)').setMinValue(0).setMaxValue(365))
        .addBooleanOption((o) => o.setName('nuke_protection').setDescription('Stop people mass deleting channels/roles or mass banning'))
        .addIntegerOption((o) => o.setName('nuke_delete_limit').setDescription('Channel/role deletes, webhooks or admin grants allowed per minute').setMinValue(1).setMaxValue(50))
        .addIntegerOption((o) => o.setName('nuke_ban_limit').setDescription('Bans and kicks allowed per minute').setMinValue(1).setMaxValue(50))
        .addStringOption((o) =>
          o.setName('nuke_action').setDescription('What to do to someone who goes over').addChoices({ name: 'Remove all their roles', value: 'strip' }, { name: 'Ban them', value: 'ban' }),
        )
        .addBooleanOption((o) => o.setName('scam_protection').setDescription('Delete scam links and fake Nitro offers')),
    )
    .addSubcommand((s) => s.setName('end-raid').setDescription('Turn off raid mode now'))
    .addSubcommandGroup((g) =>
      g
        .setName('trust')
        .setDescription('People anti-nuke leaves alone (server owner only)')
        .addSubcommand((s) => s.setName('add').setDescription('Trust someone').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Stop trusting someone').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Who’s trusted')),
    ),
  new SlashCommandBuilder()
    .setName('lockdown')
    .setDescription('Stop @everyone from talking for a while')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Lock channels')
        .addStringOption((o) => o.setName('reason').setDescription('Shown in the locked channels').setMaxLength(300))
        .addStringOption((o) => o.setName('scope').setDescription('Which channels').addChoices({ name: 'This channel', value: 'channel' }, { name: 'All text channels', value: 'all' })),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Unlock channels and put their permissions back')
        .addStringOption((o) => o.setName('scope').setDescription('Which channels').addChoices({ name: 'Everything that’s locked', value: 'all' }, { name: 'This channel', value: 'channel' })),
    ),
];

const RAID_ACTION_TEXT: Record<RaidAction, string> = { kick: 'kick', timeout: 'time out for an hour', alert: 'alert only' };

export const securityModule: Module = {
  id: 'security',
  name: 'Security',
  description: 'Anti-raid, anti-nuke, scam link protection and channel lockdowns.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async security(i, ctx) {
      const group = i.options.getSubcommandGroup();
      const sub = i.options.getSubcommand();

      if (group === 'trust') {
        if (!isOwner(ctx, i.guild, i.user.id)) return fail(i, 'Only the server owner can change the trusted list.');
        const cfg = cfgFor(ctx, i.guildId);
        if (sub === 'list') {
          return respond(i, { embeds: [embed().setTitle('Trusted by anti-nuke').setDescription(cfg.trusted.length ? cfg.trusted.map((id) => `<@${id}>`).join('\n') : 'Nobody yet. The owner and Aura are always trusted.')] });
        }
        const user = i.options.getUser('user', true);
        const trusted = sub === 'add' ? [...new Set([...cfg.trusted, user.id])] : cfg.trusted.filter((id) => id !== user.id);
        setSettings(ctx.db, i.guildId, 'security', securityDefaults, { trusted });
        return ok(i, sub === 'add' ? `Anti-nuke will leave <@${user.id}> alone.` : `<@${user.id}> isn’t trusted any more.`);
      }

      if (sub === 'end-raid') {
        return (await endRaid(ctx, i.guild, true)) ? ok(i, 'Raid mode is off.') : fail(i, 'Raid mode isn’t on.');
      }

      let cfg = cfgFor(ctx, i.guildId);
      if (sub === 'config') {
        const patch: Partial<SecurityConfig> = {};
        const bool = (name: string, key: 'raidOn' | 'raidLockdown' | 'nukeOn' | 'scamOn') => {
          const v = i.options.getBoolean(name);
          if (v !== null) patch[key] = v;
        };
        const int = (name: string, key: 'raidJoins' | 'raidSeconds' | 'raidMinutes' | 'minAccountAgeDays' | 'nukeDeleteLimit' | 'nukeBanLimit') => {
          const v = i.options.getInteger(name);
          if (v !== null) patch[key] = v;
        };
        bool('raid_protection', 'raidOn');
        bool('raid_lockdown', 'raidLockdown');
        bool('nuke_protection', 'nukeOn');
        bool('scam_protection', 'scamOn');
        int('raid_joins', 'raidJoins');
        int('raid_seconds', 'raidSeconds');
        int('raid_minutes', 'raidMinutes');
        int('min_account_age_days', 'minAccountAgeDays');
        int('nuke_delete_limit', 'nukeDeleteLimit');
        int('nuke_ban_limit', 'nukeBanLimit');
        const ra = i.options.getString('raid_action');
        if (ra) patch.raidAction = ra as RaidAction;
        const na = i.options.getString('nuke_action');
        if (na) patch.nukeAction = na as NukeAction;
        if (!Object.keys(patch).length) return fail(i, 'Pick at least one setting to change.');
        cfg = setSettings(ctx.db, i.guildId, 'security', securityDefaults, patch);
      }

      const raid = raids.get(i.guildId);
      const lines = [
        `**Anti-raid:** ${cfg.raidOn ? `on, more than ${cfg.raidJoins} joins in ${cfg.raidSeconds}s starts raid mode for ${fmtDuration(cfg.raidMinutes * 60e3)} (${RAID_ACTION_TEXT[cfg.raidAction]}${cfg.raidLockdown ? ', plus lockdown' : ''})` : 'off'}`,
        `**Minimum account age:** ${cfg.minAccountAgeDays ? `${cfg.minAccountAgeDays} day(s), younger accounts get kicked` : 'off'}`,
        `**Anti-nuke:** ${cfg.nukeOn ? `on, ${cfg.nukeDeleteLimit} deletes / ${cfg.nukeBanLimit} bans per minute, then ${cfg.nukeAction === 'ban' ? 'ban' : 'remove their roles'}` : 'off'}`,
        `**Scam protection:** ${cfg.scamOn ? 'on' : 'off'}`,
        `**Trusted:** ${cfg.trusted.length ? cfg.trusted.map((id) => `<@${id}>`).join(', ') : 'just the owner'}`,
      ];
      if (raid) lines.push(`\n🚨 **Raid mode is on** until ${ts(raid.until, 't')}.`);
      return respond(i, { embeds: [embed().setTitle(sub === 'config' ? 'Security settings saved' : 'Security settings').setDescription(lines.join('\n'))] });
    },

    async lockdown(i, ctx) {
      const sub = i.options.getSubcommand();
      const scope = i.options.getString('scope') ?? (sub === 'start' ? 'channel' : 'all');
      if (!i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return fail(i, 'I need the **Manage Roles** permission to change channel permissions.');

      if (sub === 'start') {
        let targets: Lockable[];
        if (scope === 'all') targets = textChannels(i.guild);
        else {
          if (!i.channel || !LOCKABLE.includes(i.channel.type)) return fail(i, 'Run this in a text channel, or pick **All text channels**.');
          targets = [i.channel as Lockable];
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const reason = i.options.getString('reason') ?? '';
        const { locked, skipped } = await lockChannels(ctx, i.guild, targets, { reason, by: i.user.id, source: 'manual' });
        if (!locked) return fail(i, skipped ? 'I couldn’t lock anything. Check I can manage permissions in those channels.' : 'That’s already locked.');
        await ctx.log(i.guild, 'security', embed(colors.danger).setTitle('🔒 Lockdown started').setDescription(`<@${i.user.id}> locked **${locked}** channel(s).${reason ? `\n**Reason:** ${truncate(reason, 500)}` : ''}`));
        return ok(i, `Locked **${locked}** channel(s).${skipped ? ` Skipped ${skipped} I can’t manage.` : ''} Use \`/lockdown end\` to undo it.`);
      }

      const rows =
        scope === 'channel'
          ? all<LockRow>(ctx.db, 'select * from security_lockdown where guild_id = ? and channel_id = ?', i.guildId, i.channelId)
          : all<LockRow>(ctx.db, 'select * from security_lockdown where guild_id = ?', i.guildId);
      if (!rows.length) return fail(i, scope === 'channel' ? 'This channel isn’t locked.' : 'Nothing is locked right now.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const n = await unlockChannels(ctx, i.guild, rows);
      await ctx.log(i.guild, 'security', embed(colors.success).setTitle('🔓 Lockdown ended').setDescription(`<@${i.user.id}> unlocked **${n}** channel(s).`));
      return ok(i, `Unlocked **${n}** channel(s) and put their permissions back.`);
    },
  },

  init(ctx) {
    const { client } = ctx;

    client.on(Events.GuildMemberAdd, async (m) => {
      try {
        if (!ctx.enabled(m.guild.id, 'security') || m.user.bot) return;
        const cfg = cfgFor(ctx, m.guild.id);

        if (cfg.raidOn) {
          const raid = raids.get(m.guild.id);
          if (raid && raid.until > Date.now()) return void (await handleRaider(ctx, m, cfg));
          const recent = joins.add(m.guild.id, Date.now(), cfg.raidSeconds * 1000, m.id);
          if (recent.length > cfg.raidJoins) {
            joins.clear(m.guild.id);
            return void (await startRaid(ctx, m.guild, cfg, recent.map((r) => r.v)));
          }
        }

        const minAge = cfg.minAccountAgeDays * 86400e3;
        if (minAge && Date.now() - m.user.createdTimestamp < minAge && m.kickable) {
          const okAt = m.user.createdTimestamp + minAge;
          await m.send(`Sorry, **${m.guild.name}** only lets in accounts older than ${cfg.minAccountAgeDays} day(s). You can join again ${ts(okAt, 'R')}.`).catch(() => {});
          await m.kick(`Account younger than ${cfg.minAccountAgeDays} day(s)`);
          await ctx.log(m.guild, 'security', embed(colors.warning).setTitle('👶 New account kicked').setDescription(`<@${m.id}> (${m.user.tag}) was created ${ts(m.user.createdTimestamp, 'R')}.`));
        }
      } catch (e) {
        console.warn('[security] join:', e instanceof Error ? e.message : e);
      }
    });

    client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
      try {
        if (!ctx.enabled(guild.id, 'security') || !entry.executorId) return;
        const A = AuditLogEvent;
        switch (entry.action) {
          case A.ChannelDelete:
            return await onNukeAction(ctx, guild, entry.executorId, 'destroy', 'channel deletes');
          case A.RoleDelete:
            return await onNukeAction(ctx, guild, entry.executorId, 'destroy', 'role deletes');
          case A.WebhookCreate:
            return await onNukeAction(ctx, guild, entry.executorId, 'destroy', 'webhooks created');
          case A.MemberBanAdd:
            return await onNukeAction(ctx, guild, entry.executorId, 'ban', 'bans');
          case A.MemberKick:
            return await onNukeAction(ctx, guild, entry.executorId, 'ban', 'kicks');
          case A.RoleUpdate: {
            const perms = entry.changes.find((c) => c.key === 'permissions');
            const admin = PermissionFlagsBits.Administrator;
            if (perms && BigInt(String(perms.new ?? 0)) & admin && !(BigInt(String(perms.old ?? 0)) & admin)) {
              return await onNukeAction(ctx, guild, entry.executorId, 'destroy', 'Administrator grants');
            }
          }
        }
      } catch (e) {
        console.warn('[security] audit log:', e instanceof Error ? e.message : e);
      }
    });

    client.on(Events.MessageCreate, async (msg) => {
      try {
        if (!msg.inGuild() || msg.author.bot || !msg.content || !ctx.enabled(msg.guildId, 'security')) return;
        if (!cfgFor(ctx, msg.guildId).scamOn) return;
        const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
        if (member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const why = detectScam(msg.content, Date.now() - msg.author.createdTimestamp);
        if (!why) return;
        await msg.delete().catch(() => {});
        let timedOut = false;
        if (member?.moderatable) timedOut = await member.timeout(86400e3, `Scam: ${why}`).then(() => true, () => false);
        if (timedOut) await openCase(ctx, msg.guild, { action: 'timeout', user: msg.author, modId: client.user.id, reason: `Automatic: ${why}`, durationMs: 86400e3 });
        await ctx.log(
          msg.guild,
          'security',
          embed(colors.danger)
            .setTitle('🎣 Scam message removed')
            .setDescription(truncate(msg.content, 1500))
            .addFields(
              { name: 'User', value: `<@${msg.author.id}> (${msg.author.tag})`, inline: true },
              { name: 'Channel', value: `<#${msg.channelId}>`, inline: true },
              { name: 'Why', value: why },
              { name: 'Action', value: timedOut ? 'Deleted, timed out for 1 day' : 'Deleted (couldn’t time them out)' },
            ),
        );
      } catch (e) {
        console.warn('[security] scam check:', e instanceof Error ? e.message : e);
      }
    });
  },

  async tick(ctx) {
    const now = Date.now();
    for (const [gid, raid] of raids) {
      if (raid.until > now) continue;
      const guild = ctx.client.guilds.cache.get(gid);
      if (guild) await endRaid(ctx, guild);
      else raids.delete(gid);
    }
    // raid lockdowns that outlived a restart
    const stale = all<LockRow>(ctx.db, 'select * from security_lockdown where ends_at is not null and ends_at <= ?', now);
    for (const gid of new Set(stale.map((r) => r.guild_id))) {
      const guild = ctx.client.guilds.cache.get(gid);
      if (guild && !raids.has(gid)) await unlockChannels(ctx, guild, stale.filter((r) => r.guild_id === gid));
    }
    nukeHits.prune(now, 60e3);
    joins.prune(now, 300e3);
    for (const [k, t] of recentlyPunished) if (now - t > 60e3) recentlyPunished.delete(k);
  },
};
