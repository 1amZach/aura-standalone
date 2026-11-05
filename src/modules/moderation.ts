import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction, type Guild, type User } from 'discord.js';
import { all, get, getSettings, run, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { canModerate, colors, embed, fail, fmtDuration, ok, parseDuration, respond, truncate, ts } from '../util.js';

export type CaseAction = 'warn' | 'timeout' | 'untimeout' | 'kick' | 'ban' | 'unban' | 'note';

export interface CaseRow {
  id: number;
  guild_id: string;
  num: number;
  action: CaseAction;
  user_id: string;
  mod_id: string;
  reason: string;
  duration_ms: number | null;
  expires_at: number | null;
  active: number;
  created_at: number;
}

const schema = `
create table if not exists cases (
  id integer primary key autoincrement,
  guild_id text not null,
  num integer not null,
  action text not null,
  user_id text not null,
  mod_id text not null,
  reason text not null default '',
  duration_ms integer,
  expires_at integer,
  active integer not null default 1,
  created_at integer not null,
  unique (guild_id, num)
);
create index if not exists cases_user on cases (guild_id, user_id);
create index if not exists cases_expiring on cases (expires_at) where expires_at is not null and active = 1;
`;

export const modDefaults = {
  dmUsers: true,
  warnTimeoutAt: 3,
  warnTimeoutMinutes: 60,
  warnBanAt: 0,
};

const ACTION: Record<CaseAction, { label: string; color: number; emoji: string }> = {
  warn: { label: 'Warning', color: colors.warning, emoji: '⚠️' },
  timeout: { label: 'Timeout', color: colors.warning, emoji: '🔇' },
  untimeout: { label: 'Timeout removed', color: colors.success, emoji: '🔊' },
  kick: { label: 'Kick', color: colors.danger, emoji: '👢' },
  ban: { label: 'Ban', color: colors.danger, emoji: '🔨' },
  unban: { label: 'Unban', color: colors.success, emoji: '🕊️' },
  note: { label: 'Note', color: colors.blue, emoji: '📝' },
};

export async function openCase(
  ctx: Ctx,
  guild: Guild,
  c: { action: CaseAction; user: User | { id: string; tag?: string }; modId: string; reason?: string; durationMs?: number | null },
): Promise<CaseRow> {
  const { db } = ctx;
  const num = (get<{ n: number }>(db, 'select coalesce(max(num), 0) + 1 as n from cases where guild_id = ?', guild.id)?.n ?? 1) as number;
  const now = Date.now();
  const expires = c.durationMs && (c.action === 'ban' || c.action === 'timeout') ? now + c.durationMs : null;
  run(
    db,
    'insert into cases (guild_id, num, action, user_id, mod_id, reason, duration_ms, expires_at, active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    guild.id, num, c.action, c.user.id, c.modId, c.reason ?? '', c.durationMs ?? null, expires, now,
  );
  const row = get<CaseRow>(db, 'select * from cases where guild_id = ? and num = ?', guild.id, num)!;
  await ctx.log(guild, 'mod', caseEmbed(row, 'tag' in c.user && c.user.tag ? c.user.tag : undefined));
  return row;
}

export function caseEmbed(c: CaseRow, tag?: string) {
  const a = ACTION[c.action];
  const e = embed(a.color)
    .setTitle(`${a.emoji} Case #${c.num} · ${a.label}`)
    .addFields(
      { name: 'User', value: `<@${c.user_id}>${tag ? ` (${tag})` : ''}`, inline: true },
      { name: 'Moderator', value: `<@${c.mod_id}>`, inline: true },
      { name: 'Reason', value: truncate(c.reason || 'No reason given', 1024) },
    )
    .setFooter({ text: `User id ${c.user_id}` })
    .setTimestamp(c.created_at);
  if (c.duration_ms) e.addFields({ name: 'Length', value: fmtDuration(c.duration_ms), inline: true });
  if (c.expires_at) e.addFields({ name: 'Ends', value: ts(c.expires_at, 'R'), inline: true });
  if (!c.active) e.addFields({ name: 'Status', value: 'Pardoned / lifted', inline: true });
  return e;
}

async function dm(ctx: Ctx, guild: Guild, user: User, action: CaseAction, reason: string, durationMs?: number | null) {
  if (!getSettings(ctx.db, guild.id, 'moderation', modDefaults).dmUsers) return;
  const verb: Partial<Record<CaseAction, string>> = { warn: 'warned', timeout: 'timed out', kick: 'kicked', ban: 'banned' };
  if (!verb[action]) return;
  await user
    .send({
      embeds: [
        embed(ACTION[action].color)
          .setTitle(`You were ${verb[action]} in ${guild.name}`)
          .setDescription(`**Reason:** ${reason || 'No reason given'}${durationMs ? `\n**Length:** ${fmtDuration(durationMs)}` : ''}`),
      ],
    })
    .catch(() => {});
}

export const activeWarnings = (db: DB, guildId: string, userId: string) =>
  get<{ n: number }>(db, "select count(*) as n from cases where guild_id = ? and user_id = ? and action = 'warn' and active = 1", guildId, userId)?.n ?? 0;

async function escalate(ctx: Ctx, guild: Guild, user: User, reasonPrefix: string) {
  const cfg = getSettings(ctx.db, guild.id, 'moderation', modDefaults);
  const n = activeWarnings(ctx.db, guild.id, user.id);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (cfg.warnBanAt && n >= cfg.warnBanAt) {
    await dm(ctx, guild, user, 'ban', `${reasonPrefix} (${n} warnings)`);
    await guild.members.ban(user.id, { reason: `Auto-ban: ${n} warnings` }).catch(() => {});
    await openCase(ctx, guild, { action: 'ban', user, modId: ctx.client.user.id, reason: `Automatic: reached ${n} warnings` });
    return `They reached ${n} warnings and were banned.`;
  }
  if (cfg.warnTimeoutAt && n >= cfg.warnTimeoutAt && member?.moderatable) {
    const ms = cfg.warnTimeoutMinutes * 60e3;
    await member.timeout(ms, `Auto-timeout: ${n} warnings`).catch(() => {});
    await openCase(ctx, guild, { action: 'timeout', user, modId: ctx.client.user.id, reason: `Automatic: reached ${n} warnings`, durationMs: ms });
    return `They reached ${n} warnings and were timed out for ${fmtDuration(ms)}.`;
  }
  return null;
}

export async function warnUser(ctx: Ctx, guild: Guild, user: User, modId: string, reason: string) {
  await dm(ctx, guild, user, 'warn', reason);
  const c = await openCase(ctx, guild, { action: 'warn', user, modId, reason });
  const extra = await escalate(ctx, guild, user, reason);
  return { c, extra };
}

const userOpt = (b: SlashCommandBuilder, desc = 'Who') => b.addUserOption((o) => o.setName('user').setDescription(desc).setRequired(true));
const reasonOpt = <T extends { addStringOption: SlashCommandBuilder['addStringOption'] }>(b: T) =>
  b.addStringOption((o) => o.setName('reason').setDescription('Why (they see this)').setMaxLength(500));

const commands = [
  reasonOpt(userOpt(new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers))),
  reasonOpt(
    userOpt(new SlashCommandBuilder().setName('timeout').setDescription('Time out a member').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)).addStringOption((o) =>
      o.setName('duration').setDescription('How long, e.g. 10m, 2h, 1d (max 28d)').setRequired(true),
    ),
  ),
  reasonOpt(userOpt(new SlashCommandBuilder().setName('untimeout').setDescription('Remove a timeout').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers))),
  reasonOpt(userOpt(new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers))),
  reasonOpt(
    userOpt(new SlashCommandBuilder().setName('ban').setDescription('Ban someone (they don’t need to be in the server)').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers))
      .addStringOption((o) => o.setName('duration').setDescription('Temporary ban length, e.g. 7d. Leave empty for permanent'))
      .addIntegerOption((o) =>
        o.setName('delete_messages').setDescription('Delete their recent messages').addChoices({ name: 'None', value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last day', value: 86400 }, { name: 'Last week', value: 604800 }),
      ),
  ),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban someone')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('Their user id').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Bulk delete recent messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('amount').setDescription('How many (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('Only messages from this person'))
    .addBooleanOption((o) => o.setName('bots').setDescription('Only messages from bots')),
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Set slowmode in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 5s, 1m, 0 to turn off').setRequired(true)),
  new SlashCommandBuilder()
    .setName('case')
    .setDescription('Look up or change a moderation case')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) => s.setName('view').setDescription('Show a case').addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName('reason')
        .setDescription('Change a case’s reason')
        .addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(500)),
    )
    .addSubcommand((s) => s.setName('pardon').setDescription('Pardon a warning so it stops counting').addIntegerOption((o) => o.setName('number').setDescription('Case number').setRequired(true))),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('A member’s moderation history')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)),
  new SlashCommandBuilder()
    .setName('note')
    .setDescription('Add a private staff note to a member’s history')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
    .addStringOption((o) => o.setName('text').setDescription('The note').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Account info, join date, roles and case count')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)),
  new SlashCommandBuilder()
    .setName('modconfig')
    .setDescription('Moderation settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) => o.setName('dm_users').setDescription('DM people when they get a warning, timeout, kick or ban'))
    .addIntegerOption((o) => o.setName('warn_timeout_at').setDescription('Auto-timeout at this many warnings (0 = off)').setMinValue(0).setMaxValue(20))
    .addIntegerOption((o) => o.setName('warn_timeout_minutes').setDescription('Length of that timeout in minutes').setMinValue(1).setMaxValue(40320))
    .addIntegerOption((o) => o.setName('warn_ban_at').setDescription('Auto-ban at this many warnings (0 = off)').setMinValue(0).setMaxValue(50)),
];

async function target(i: ChatInputCommandInteraction<'cached'>) {
  const user = i.options.getUser('user', true);
  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (member) {
    const why = canModerate(i.member, member);
    if (why) {
      await fail(i, why);
      return null;
    }
  }
  return { user, member };
}

export const moderationModule: Module = {
  id: 'moderation',
  name: 'Moderation',
  description: 'Warnings, timeouts, kicks, bans (including temporary), purge, case history and user lookup.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async warn(i, ctx) {
      const t = await target(i);
      if (!t) return;
      if (!t.member) return fail(i, 'They’re not in the server.');
      const reason = i.options.getString('reason') ?? '';
      const { c, extra } = await warnUser(ctx, i.guild, t.user, i.user.id, reason);
      return ok(i, `Warned <@${t.user.id}> (case #${c.num}). They have **${activeWarnings(ctx.db, i.guildId, t.user.id)}** active warning(s).${extra ? `\n${extra}` : ''}`, false);
    },
    async timeout(i, ctx) {
      const t = await target(i);
      if (!t) return;
      if (!t.member) return fail(i, 'They’re not in the server.');
      const ms = parseDuration(i.options.getString('duration', true));
      if (!ms || ms > 28 * 86400e3) return fail(i, 'Give a length like `10m`, `2h` or `1d`, up to 28 days.');
      if (!t.member.moderatable) return fail(i, 'I can’t time them out. Check my role is above theirs and I have Timeout Members.');
      const reason = i.options.getString('reason') ?? '';
      await dm(ctx, i.guild, t.user, 'timeout', reason, ms);
      await t.member.timeout(ms, `${i.user.tag}: ${reason || 'no reason'}`);
      const c = await openCase(ctx, i.guild, { action: 'timeout', user: t.user, modId: i.user.id, reason, durationMs: ms });
      return ok(i, `Timed out <@${t.user.id}> for ${fmtDuration(ms)} (case #${c.num}).`, false);
    },
    async untimeout(i, ctx) {
      const t = await target(i);
      if (!t) return;
      if (!t.member?.isCommunicationDisabled()) return fail(i, 'They’re not timed out.');
      const reason = i.options.getString('reason') ?? '';
      await t.member.timeout(null, `${i.user.tag}: ${reason || 'no reason'}`);
      run(ctx.db, "update cases set active = 0 where guild_id = ? and user_id = ? and action = 'timeout' and active = 1", i.guildId, t.user.id);
      const c = await openCase(ctx, i.guild, { action: 'untimeout', user: t.user, modId: i.user.id, reason });
      return ok(i, `Removed <@${t.user.id}>’s timeout (case #${c.num}).`, false);
    },
    async kick(i, ctx) {
      const t = await target(i);
      if (!t) return;
      if (!t.member) return fail(i, 'They’re not in the server.');
      if (!t.member.kickable) return fail(i, 'I can’t kick them. Check my role is above theirs and I have Kick Members.');
      const reason = i.options.getString('reason') ?? '';
      await dm(ctx, i.guild, t.user, 'kick', reason);
      await t.member.kick(`${i.user.tag}: ${reason || 'no reason'}`);
      const c = await openCase(ctx, i.guild, { action: 'kick', user: t.user, modId: i.user.id, reason });
      return ok(i, `Kicked **${t.user.tag}** (case #${c.num}).`, false);
    },
    async ban(i, ctx) {
      const t = await target(i);
      if (!t) return;
      if (t.member && !t.member.bannable) return fail(i, 'I can’t ban them. Check my role is above theirs and I have Ban Members.');
      const raw = i.options.getString('duration');
      const ms = raw ? parseDuration(raw) : null;
      if (raw && !ms) return fail(i, 'Give a length like `12h`, `7d` or `4w`, or leave it empty for a permanent ban.');
      const reason = i.options.getString('reason') ?? '';
      if (t.member) await dm(ctx, i.guild, t.user, 'ban', reason, ms);
      await i.guild.members.ban(t.user.id, { reason: `${i.user.tag}: ${reason || 'no reason'}`, deleteMessageSeconds: i.options.getInteger('delete_messages') ?? 0 });
      const c = await openCase(ctx, i.guild, { action: 'ban', user: t.user, modId: i.user.id, reason, durationMs: ms });
      return ok(i, `Banned **${t.user.tag}**${ms ? ` for ${fmtDuration(ms)}` : ''} (case #${c.num}).`, false);
    },
    async unban(i, ctx) {
      const id = i.options.getString('user_id', true).replace(/\D/g, '');
      const ban = await i.guild.bans.fetch(id).catch(() => null);
      if (!ban) return fail(i, 'That user isn’t banned.');
      const reason = i.options.getString('reason') ?? '';
      await i.guild.members.unban(id, `${i.user.tag}: ${reason || 'no reason'}`);
      run(ctx.db, "update cases set active = 0 where guild_id = ? and user_id = ? and action = 'ban' and active = 1", i.guildId, id);
      const c = await openCase(ctx, i.guild, { action: 'unban', user: ban.user, modId: i.user.id, reason });
      return ok(i, `Unbanned **${ban.user.tag}** (case #${c.num}).`, false);
    },
    async purge(i, ctx) {
      const ch = i.channel;
      if (!ch || !('bulkDelete' in ch)) return fail(i, 'I can’t purge here.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const amount = i.options.getInteger('amount', true);
      const who = i.options.getUser('user');
      const bots = i.options.getBoolean('bots');
      const fetched = await ch.messages.fetch({ limit: 100 });
      const cutoff = Date.now() - 14 * 86400e3 + 60e3;
      const pick = [...fetched.values()].filter((m) => m.createdTimestamp > cutoff && (!who || m.author.id === who.id) && (!bots || m.author.bot)).slice(0, amount);
      const done = await ch.bulkDelete(pick, true);
      await ctx.log(i.guild, 'mod', embed(colors.warning).setTitle('🧹 Purge').setDescription(`<@${i.user.id}> deleted **${done.size}** message(s) in <#${ch.id}>${who ? ` from <@${who.id}>` : ''}${bots ? ' (bots only)' : ''}.`));
      return i.editReply({ embeds: [embed(colors.success).setDescription(`✅ Deleted ${done.size} message(s).${done.size < amount ? ' Messages older than 14 days can’t be bulk deleted.' : ''}`)] });
    },
    async slowmode(i) {
      const raw = i.options.getString('duration', true).trim();
      const ms = raw === '0' || raw === 'off' ? 0 : parseDuration(raw);
      if (ms === null || ms > 6 * 3600e3) return fail(i, 'Give a length like `5s` or `1m` (max 6h), or `0` to turn it off.');
      const ch = i.channel;
      if (!ch || ch.type !== ChannelType.GuildText) return fail(i, 'Slowmode works in text channels.');
      await ch.setRateLimitPerUser(Math.round(ms / 1000), `By ${i.user.tag}`);
      return ok(i, ms ? `Slowmode is now ${fmtDuration(ms)}.` : 'Slowmode is off.', false);
    },
    async case(i, ctx) {
      const num = i.options.getInteger('number', true);
      const c = get<CaseRow>(ctx.db, 'select * from cases where guild_id = ? and num = ?', i.guildId, num);
      if (!c) return fail(i, `There’s no case #${num}.`);
      const sub = i.options.getSubcommand();
      if (sub === 'reason') {
        run(ctx.db, 'update cases set reason = ? where id = ?', i.options.getString('reason', true), c.id);
        return ok(i, `Updated the reason on case #${num}.`);
      }
      if (sub === 'pardon') {
        if (c.action !== 'warn') return fail(i, 'Only warnings can be pardoned.');
        run(ctx.db, 'update cases set active = 0 where id = ?', c.id);
        await ctx.log(i.guild, 'mod', embed(colors.success).setDescription(`🕊️ <@${i.user.id}> pardoned warning case #${num} for <@${c.user_id}>.`));
        return ok(i, `Pardoned case #${num}.`);
      }
      return respond(i, { embeds: [caseEmbed(get<CaseRow>(ctx.db, 'select * from cases where id = ?', c.id)!)] });
    },
    async history(i, ctx) {
      const user = i.options.getUser('user', true);
      const rows = all<CaseRow>(ctx.db, 'select * from cases where guild_id = ? and user_id = ? order by num desc limit 25', i.guildId, user.id);
      if (!rows.length) return respond(i, { embeds: [embed().setDescription(`<@${user.id}> has a clean record.`)] });
      const lines = rows.map((c) => `\`#${c.num}\` ${ACTION[c.action].emoji} **${ACTION[c.action].label}**${c.active ? '' : ' ~~(lifted)~~'} · ${ts(c.created_at, 'R')} · <@${c.mod_id}>\n> ${truncate(c.reason || 'No reason', 120)}`);
      return respond(i, {
        embeds: [embed().setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() }).setTitle('Moderation history').setDescription(truncate(lines.join('\n'), 4000)).setFooter({ text: `${activeWarnings(ctx.db, i.guildId, user.id)} active warning(s)` })],
      });
    },
    async note(i, ctx) {
      const user = i.options.getUser('user', true);
      const c = await openCase(ctx, i.guild, { action: 'note', user, modId: i.user.id, reason: i.options.getString('text', true) });
      return ok(i, `Added a note to <@${user.id}>’s history (case #${c.num}).`);
    },
    async lookup(i, ctx) {
      const user = await i.options.getUser('user', true).fetch();
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      const counts = all<{ action: string; n: number }>(ctx.db, 'select action, count(*) as n from cases where guild_id = ? and user_id = ? group by action', i.guildId, user.id);
      const ban = member ? null : await i.guild.bans.fetch(user.id).catch(() => null);
      const e = embed(user.accentColor ?? colors.primary)
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'User', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
          { name: 'Account created', value: `${ts(user.createdTimestamp, 'D')}\n${ts(user.createdTimestamp, 'R')}`, inline: true },
          { name: 'Joined', value: member?.joinedTimestamp ? `${ts(member.joinedTimestamp, 'D')}\n${ts(member.joinedTimestamp, 'R')}` : ban ? '**Banned**' : 'Not in the server', inline: true },
        );
      if (member) {
        const roles = member.roles.cache.filter((r) => r.id !== i.guildId).sort((a, b) => b.position - a.position).map((r) => `<@&${r.id}>`);
        e.addFields({ name: `Roles (${roles.length})`, value: truncate(roles.join(' ') || 'none', 1024) });
        if (member.isCommunicationDisabled()) e.addFields({ name: 'Timed out until', value: ts(member.communicationDisabledUntilTimestamp!, 'f') });
      }
      if (user.bot) e.setDescription('🤖 This is a bot.');
      e.addFields({ name: 'Cases', value: counts.length ? counts.map((c) => `${ACTION[c.action as CaseAction]?.emoji ?? ''} ${c.n} ${c.action}`).join(' · ') : 'None' }, {
        name: 'Active warnings',
        value: String(activeWarnings(ctx.db, i.guildId, user.id)),
        inline: true,
      });
      return respond(i, { embeds: [e] });
    },
    async modconfig(i, { db }) {
      const patch: Partial<typeof modDefaults> = {};
      const b = i.options.getBoolean('dm_users');
      if (b !== null) patch.dmUsers = b;
      const a = i.options.getInteger('warn_timeout_at');
      if (a !== null) patch.warnTimeoutAt = a;
      const m = i.options.getInteger('warn_timeout_minutes');
      if (m !== null) patch.warnTimeoutMinutes = m;
      const bn = i.options.getInteger('warn_ban_at');
      if (bn !== null) patch.warnBanAt = bn;
      const cfg = Object.keys(patch).length ? setSettings(db, i.guildId, 'moderation', modDefaults, patch) : getSettings(db, i.guildId, 'moderation', modDefaults);
      return respond(i, {
        embeds: [
          embed()
            .setTitle('Moderation settings')
            .setDescription(
              [
                `**DM people about actions:** ${cfg.dmUsers ? 'on' : 'off'}`,
                `**Auto-timeout:** ${cfg.warnTimeoutAt ? `at ${cfg.warnTimeoutAt} warnings, for ${fmtDuration(cfg.warnTimeoutMinutes * 60e3)}` : 'off'}`,
                `**Auto-ban:** ${cfg.warnBanAt ? `at ${cfg.warnBanAt} warnings` : 'off'}`,
              ].join('\n'),
            ),
        ],
      });
    },
  },
  async tick(ctx) {
    // expired temp bans
    const due = all<CaseRow>(ctx.db, "select * from cases where action = 'ban' and active = 1 and expires_at is not null and expires_at <= ?", Date.now());
    for (const c of due) {
      run(ctx.db, 'update cases set active = 0 where id = ?', c.id);
      const guild = ctx.client.guilds.cache.get(c.guild_id);
      if (!guild) continue;
      const ok = await guild.members.unban(c.user_id, `Temporary ban (case #${c.num}) ended`).then(() => true, () => false);
      if (ok) await openCase(ctx, guild, { action: 'unban', user: { id: c.user_id }, modId: ctx.client.user.id, reason: `Temporary ban from case #${c.num} ended` });
    }
    // discord ends timeouts itself, we just close the case
    run(ctx.db, "update cases set active = 0 where action = 'timeout' and active = 1 and expires_at is not null and expires_at <= ?", Date.now());
  },
};
