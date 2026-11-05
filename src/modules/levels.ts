import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Guild,
  type GuildMember,
  type Message,
} from 'discord.js';
import { all, get, getSettings, run, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, errEmbed, fail, fill, memberVars, ok, okEmbed, respond, truncate, warnEmbed } from '../util.js';


export const xpForLevel = (n: number) => 5 * n * n + 50 * n + 100;

export function levelFromXp(xp: number): { level: number; into: number; needed: number } {
  let rest = Math.max(0, Math.floor(xp));
  let level = 0;
  while (rest >= xpForLevel(level)) {
    rest -= xpForLevel(level);
    level++;
  }
  return { level, into: rest, needed: xpForLevel(level) };
}

export function progressBar(fraction: number, length = 10): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.floor(f * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}


const schema = `
create table if not exists levels_users (
  guild_id text not null,
  user_id text not null,
  xp integer not null default 0,
  last_xp_at integer not null default 0,
  primary key (guild_id, user_id)
);
create index if not exists levels_users_rank on levels_users (guild_id, xp desc);
create table if not exists levels_rewards (
  guild_id text not null,
  level integer not null,
  role_id text not null,
  primary key (guild_id, level)
);
`;

export const levelDefaults = {
  announce: 'same' as 'same' | 'channel' | 'dm' | 'off',
  announceChannelId: '',
  message: 'GG {user}, you reached level **{level}**!',
  // replace = only the highest reward role is kept
  rewardMode: 'stack' as 'stack' | 'replace',
  multiplier: 1,
  noXpChannels: [] as string[],
  noXpRoles: [] as string[],
};
type LevelSettings = typeof levelDefaults;

const COOLDOWN_MS = 60_000;
const PAGE_SIZE = 10;

interface UserRow {
  guild_id: string;
  user_id: string;
  xp: number;
  last_xp_at: number;
}
interface RewardRow {
  guild_id: string;
  level: number;
  role_id: string;
}

const getXp = (db: DB, g: string, u: string) => get<UserRow>(db, 'select * from levels_users where guild_id = ? and user_id = ?', g, u)?.xp ?? 0;

function setXp(db: DB, g: string, u: string, xp: number) {
  run(
    db,
    'insert into levels_users (guild_id, user_id, xp, last_xp_at) values (?, ?, ?, 0) on conflict (guild_id, user_id) do update set xp = excluded.xp',
    g, u, Math.max(0, Math.floor(xp)),
  );
}

const rankOf = (db: DB, g: string, xp: number) => (get<{ n: number }>(db, 'select count(*) as n from levels_users where guild_id = ? and xp > ?', g, xp)?.n ?? 0) + 1;

export async function syncRewards(db: DB, member: GuildMember, level: number) {
  try {
    const cfg = getSettings(db, member.guild.id, 'levels', levelDefaults);
    const rewards = all<RewardRow>(db, 'select * from levels_rewards where guild_id = ? order by level asc', member.guild.id);
    if (!rewards.length) return;
    const earned = rewards.filter((r) => r.level <= level);
    const want = new Set(cfg.rewardMode === 'replace' ? earned.slice(-1).map((r) => r.role_id) : earned.map((r) => r.role_id));
    const add: string[] = [];
    const remove: string[] = [];
    for (const r of rewards) {
      const role = member.guild.roles.cache.get(r.role_id);
      if (!role?.editable) continue;
      const has = member.roles.cache.has(r.role_id);
      if (want.has(r.role_id) && !has) add.push(r.role_id);
      else if (!want.has(r.role_id) && has) remove.push(r.role_id);
    }
    if (add.length) await member.roles.add(add, `Level ${level} reward`);
    if (remove.length) await member.roles.remove(remove, `Level ${level} reward update`);
  } catch (e) {
    console.warn(`[levels] rewards ${member.guild.id}/${member.id}:`, e instanceof Error ? e.message : e);
  }
}

async function announceLevelUp(cfg: LevelSettings, msg: Message<true>, member: GuildMember, level: number) {
  if (cfg.announce === 'off') return;
  const content = truncate(fill(cfg.message, { ...memberVars(member), level }), 2000);
  const opts = { content, allowedMentions: { users: [member.id] } };
  try {
    if (cfg.announce === 'dm') await member.send(opts);
    else if (cfg.announce === 'channel' && cfg.announceChannelId) {
      const ch = msg.guild.channels.cache.get(cfg.announceChannelId);
      if (ch?.isSendable()) await ch.send(opts);
    } else if (msg.channel.isSendable()) await msg.channel.send(opts);
  } catch (e) {
    console.warn(`[levels] announce ${msg.guildId}:`, e instanceof Error ? e.message : e);
  }
}

async function onMessage(ctx: Ctx, msg: Message) {
  if (!msg.inGuild() || msg.author.bot || msg.webhookId) return;
  if (!ctx.enabled(msg.guildId, 'levels')) return;
  if (msg.content.trim().length < 3) return;
  const { db } = ctx;
  const cfg = getSettings(db, msg.guildId, 'levels', levelDefaults);
  if (!(cfg.multiplier > 0)) return;
  const parent = msg.channel.isThread() ? msg.channel.parentId : null;
  if (cfg.noXpChannels.includes(msg.channelId) || (parent && cfg.noXpChannels.includes(parent))) return;
  const member = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
  if (!member) return;
  if (cfg.noXpRoles.some((r) => member.roles.cache.has(r))) return;

  // no await between the read and the write, so two quick messages can't both get XP
  const now = Date.now();
  const row = get<UserRow>(db, 'select * from levels_users where guild_id = ? and user_id = ?', msg.guildId, msg.author.id);
  if (row && now - row.last_xp_at < COOLDOWN_MS) return;
  const before = row?.xp ?? 0;
  const gain = Math.max(1, Math.round((15 + Math.floor(Math.random() * 11)) * cfg.multiplier));
  run(
    db,
    'insert into levels_users (guild_id, user_id, xp, last_xp_at) values (?, ?, ?, ?) on conflict (guild_id, user_id) do update set xp = xp + excluded.xp, last_xp_at = excluded.last_xp_at',
    msg.guildId, msg.author.id, gain, now,
  );
  const oldLevel = levelFromXp(before).level;
  const newLevel = levelFromXp(before + gain).level;
  if (newLevel > oldLevel) {
    await announceLevelUp(cfg, msg, member, newLevel);
    await syncRewards(db, member, newLevel);
  }
}


function leaderboardView(db: DB, guild: Guild, page: number) {
  const total = get<{ n: number }>(db, 'select count(*) as n from levels_users where guild_id = ? and xp > 0', guild.id)?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const rows = all<UserRow>(db, 'select * from levels_users where guild_id = ? and xp > 0 order by xp desc, user_id asc limit ? offset ?', guild.id, PAGE_SIZE, p * PAGE_SIZE);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, n) => {
    const pos = p * PAGE_SIZE + n + 1;
    return `${medals[pos - 1] ?? `**${pos}.**`} <@${r.user_id}> · Level **${levelFromXp(r.xp).level}** · ${r.xp.toLocaleString('en-US')} XP`;
  });
  const e = embed()
    .setTitle(`🏆 ${guild.name} leaderboard`)
    .setDescription(lines.join('\n') || 'Nobody has any XP yet. Start chatting!')
    .setFooter({ text: `Page ${p + 1} of ${pages} · ${total} member${total === 1 ? '' : 's'} ranked` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lb:${p - 1}`).setLabel('Prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p <= 0),
    new ButtonBuilder().setCustomId(`lb:${p + 1}`).setLabel('Next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

function settingsEmbed(db: DB, guildId: string) {
  const cfg = getSettings(db, guildId, 'levels', levelDefaults);
  const where = { same: 'the channel they leveled up in', channel: cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : 'a set channel (none picked yet)', dm: 'their DMs', off: 'nowhere (off)' }[cfg.announce];
  return embed()
    .setTitle('Levels settings')
    .setDescription(
      [
        `**Level-up messages:** ${where}`,
        `**Message:** ${truncate(cfg.message, 300)}`,
        `**Reward roles:** ${cfg.rewardMode === 'stack' ? 'stack (keep them all)' : 'replace (keep only the highest)'}`,
        `**XP multiplier:** ×${cfg.multiplier}`,
        `**No-XP channels:** ${cfg.noXpChannels.map((c) => `<#${c}>`).join(' ') || 'none'}`,
        `**No-XP roles:** ${cfg.noXpRoles.map((r) => `<@&${r}>`).join(' ') || 'none'}`,
      ].join('\n'),
    )
    .setFooter({ text: 'Placeholders: {user} {user.name} {level} {server}' });
}


const commands = [
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your level and XP, or someone else’s')
    .addUserOption((o) => o.setName('user').setDescription('Whose rank to show')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('The top members by XP'),
  new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Set up levelling')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('config')
        .setDescription('Change or view levelling settings')
        .addStringOption((o) =>
          o
            .setName('announce')
            .setDescription('Where level-up messages go')
            .addChoices({ name: 'Same channel', value: 'same' }, { name: 'A set channel', value: 'channel' }, { name: 'DM the member', value: 'dm' }, { name: 'Off', value: 'off' }),
        )
        .addChannelOption((o) => o.setName('channel').setDescription('Channel for level-up messages').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('message').setDescription('Level-up message. Use {user} and {level}').setMaxLength(500))
        .addStringOption((o) =>
          o
            .setName('reward_mode')
            .setDescription('Keep every reward role, or only the highest')
            .addChoices({ name: 'Stack (keep all)', value: 'stack' }, { name: 'Replace (highest only)', value: 'replace' }),
        )
        .addNumberOption((o) => o.setName('multiplier').setDescription('XP multiplier, e.g. 1.5 (0 stops XP)').setMinValue(0).setMaxValue(10)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('reward')
        .setDescription('Roles given at a level')
        .addSubcommand((s) =>
          s
            .setName('add')
            .setDescription('Give a role at a level')
            .addIntegerOption((o) => o.setName('level').setDescription('Level').setMinValue(1).setMaxValue(1000).setRequired(true))
            .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('remove')
            .setDescription('Stop giving a role at a level')
            .addIntegerOption((o) => o.setName('level').setDescription('Level').setMinValue(1).setMaxValue(1000).setRequired(true)),
        )
        .addSubcommand((s) => s.setName('list').setDescription('Show all reward roles')),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('ignore')
        .setDescription('Channels and roles that don’t earn XP')
        .addSubcommand((s) =>
          s
            .setName('channel')
            .setDescription('Turn XP off or back on in a channel')
            .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName('role')
            .setDescription('Turn XP off or back on for a role')
            .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
        ),
    )
    .addSubcommandGroup((g) =>
      g
        .setName('reset')
        .setDescription('Wipe XP')
        .addSubcommand((s) =>
          s
            .setName('user')
            .setDescription('Reset one member’s XP')
            .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)),
        )
        .addSubcommand((s) => s.setName('all').setDescription('Reset everyone’s XP in this server')),
    ),
  (() => {
    const b = new SlashCommandBuilder().setName('xp').setDescription('Change a member’s XP').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
    for (const [name, desc] of [
      ['give', 'Give XP'],
      ['take', 'Take XP away'],
      ['set', 'Set XP to an exact amount'],
    ] as const) {
      b.addSubcommand((s) =>
        s
          .setName(name)
          .setDescription(desc)
          .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('How much XP').setMinValue(0).setMaxValue(10_000_000).setRequired(true)),
      );
    }
    return b;
  })(),
];

export const levelsModule: Module = {
  id: 'levels',
  name: 'Levels',
  description: 'XP for chatting, level-up messages, reward roles, /rank and a leaderboard.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  init(ctx) {
    ctx.client.on(Events.MessageCreate, (msg) => {
      onMessage(ctx, msg).catch((e) => console.warn('[levels] message:', e instanceof Error ? e.message : e));
    });
  },
  handle: {
    async rank(i, { db }) {
      const user = i.options.getUser('user') ?? i.user;
      if (user.bot) return fail(i, 'Bots don’t earn XP.');
      const xp = getXp(db, i.guildId, user.id);
      const { level, into, needed } = levelFromXp(xp);
      const ranked = get<{ n: number }>(db, 'select count(*) as n from levels_users where guild_id = ? and xp > 0', i.guildId)?.n ?? 0;
      const e = embed()
        .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Level', value: `**${level}**`, inline: true },
          { name: 'Rank', value: xp > 0 ? `**#${rankOf(db, i.guildId, xp)}** of ${ranked}` : 'Unranked', inline: true },
          { name: 'Total XP', value: xp.toLocaleString('en-US'), inline: true },
          { name: `Progress to level ${level + 1}`, value: `${progressBar(into / needed)} ${into.toLocaleString('en-US')} / ${needed.toLocaleString('en-US')} XP` },
        );
      return respond(i, { embeds: [e] }, false);
    },
    async leaderboard(i, { db }) {
      return respond(i, leaderboardView(db, i.guild, 0), false);
    },
    async levels(i, { db }) {
      const group = i.options.getSubcommandGroup();
      const sub = i.options.getSubcommand();
      const g = i.guildId;
      if (!group && sub === 'config') {
        const patch: Partial<LevelSettings> = {};
        const a = i.options.getString('announce') as LevelSettings['announce'] | null;
        if (a) patch.announce = a;
        const ch = i.options.getChannel('channel');
        if (ch) {
          patch.announceChannelId = ch.id;
          if (!a) patch.announce = 'channel';
        }
        const m = i.options.getString('message');
        if (m) patch.message = m;
        const rm = i.options.getString('reward_mode') as LevelSettings['rewardMode'] | null;
        if (rm) patch.rewardMode = rm;
        const mult = i.options.getNumber('multiplier');
        if (mult !== null) patch.multiplier = Math.round(mult * 100) / 100;
        const cfg = Object.keys(patch).length ? setSettings(db, g, 'levels', levelDefaults, patch) : getSettings(db, g, 'levels', levelDefaults);
        const embeds = [settingsEmbed(db, g)];
        if (cfg.announce === 'channel' && !cfg.announceChannelId) embeds.push(warnEmbed('Pick a channel with the `channel` option, or level-ups won’t be posted anywhere.'));
        return respond(i, { embeds });
      }
      if (group === 'reward') {
        if (sub === 'list') {
          const rows = all<RewardRow>(db, 'select * from levels_rewards where guild_id = ? order by level asc', g);
          const mode = getSettings(db, g, 'levels', levelDefaults).rewardMode;
          return respond(i, {
            embeds: [
              embed()
                .setTitle('Level rewards')
                .setDescription(rows.map((r) => `Level **${r.level}** → <@&${r.role_id}>`).join('\n') || 'No reward roles yet. Add one with `/levels reward add`.')
                .setFooter({ text: mode === 'stack' ? 'Members keep every reward they’ve earned.' : 'Members keep only their highest reward.' }),
            ],
          });
        }
        const level = i.options.getInteger('level', true);
        if (sub === 'remove') {
          const r = run(db, 'delete from levels_rewards where guild_id = ? and level = ?', g, level);
          return r.changes ? ok(i, `Level ${level} no longer gives a role. Members who already have it keep it.`) : fail(i, `There’s no reward at level ${level}.`);
        }
        const role = i.options.getRole('role', true);
        if (role.id === g || role.managed) return fail(i, 'That role can’t be given out. Pick a normal role.');
        if (!i.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return fail(i, 'I need the **Manage Roles** permission to give reward roles.');
        if (!i.guild.roles.cache.get(role.id)?.editable) return fail(i, `<@&${role.id}> is above my highest role, so I can’t give it. Move my role above it first.`);
        run(db, 'insert into levels_rewards (guild_id, level, role_id) values (?, ?, ?) on conflict (guild_id, level) do update set role_id = excluded.role_id', g, level, role.id);
        return ok(i, `Members will get <@&${role.id}> at level **${level}**. People already past that level get it next time they level up.`);
      }
      if (group === 'ignore') {
        const cfg = getSettings(db, g, 'levels', levelDefaults);
        if (sub === 'channel') {
          const ch = i.options.getChannel('channel', true);
          const on = cfg.noXpChannels.includes(ch.id);
          setSettings(db, g, 'levels', levelDefaults, { noXpChannels: on ? cfg.noXpChannels.filter((c) => c !== ch.id) : [...cfg.noXpChannels, ch.id] });
          return ok(i, on ? `<#${ch.id}> earns XP again.` : `Messages in <#${ch.id}> won’t earn XP now.`);
        }
        const role = i.options.getRole('role', true);
        const on = cfg.noXpRoles.includes(role.id);
        setSettings(db, g, 'levels', levelDefaults, { noXpRoles: on ? cfg.noXpRoles.filter((r) => r !== role.id) : [...cfg.noXpRoles, role.id] });
        return ok(i, on ? `<@&${role.id}> earns XP again.` : `Members with <@&${role.id}> won’t earn XP now.`);
      }
      if (group === 'reset') {
        if (sub === 'user') {
          const user = i.options.getUser('user', true);
          run(db, 'delete from levels_users where guild_id = ? and user_id = ?', g, user.id);
          const member = await i.guild.members.fetch(user.id).catch(() => null);
          if (member) await syncRewards(db, member, 0);
          return ok(i, `Reset <@${user.id}>’s XP to zero.`);
        }
        const count = get<{ n: number }>(db, 'select count(*) as n from levels_users where guild_id = ?', g)?.n ?? 0;
        return respond(i, {
          embeds: [warnEmbed(`This wipes XP for **${count}** member${count === 1 ? '' : 's'} and can’t be undone. Reward roles they already have stay. Sure?`)],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId('lb:reset:yes').setLabel('Reset everyone').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('lb:reset:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
            ),
          ],
        });
      }
      return fail(i, 'Unknown option.');
    },
    async xp(i, { db }) {
      const sub = i.options.getSubcommand() as 'give' | 'take' | 'set';
      const user = i.options.getUser('user', true);
      if (user.bot) return fail(i, 'Bots don’t earn XP.');
      const amount = i.options.getInteger('amount', true);
      const before = getXp(db, i.guildId, user.id);
      const after = Math.max(0, sub === 'give' ? before + amount : sub === 'take' ? before - amount : amount);
      setXp(db, i.guildId, user.id, after);
      const { level } = levelFromXp(after);
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (member) await syncRewards(db, member, level);
      return ok(i, `<@${user.id}> now has **${after.toLocaleString('en-US')} XP** (level ${level}).`);
    },
  },
  components: {
    async lb(i, args, { db }) {
      if (!i.isButton()) return;
      if (args[0] === 'reset') return confirmReset(i, args[1] === 'yes', db);
      const page = Number(args[0]);
      if (!Number.isFinite(page)) return;
      return i.update(leaderboardView(db, i.guild!, page));
    },
  },
};

async function confirmReset(i: ButtonInteraction, yes: boolean, db: DB) {
  if (!i.inCachedGuild()) return;
  if (!yes) return i.update({ embeds: [embed(colors.muted).setDescription('Cancelled. Nobody’s XP was changed.')], components: [] });
  if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return i.update({ embeds: [errEmbed('You need **Manage Server** to do that.')], components: [] });
  const r = run(db, 'delete from levels_users where guild_id = ?', i.guildId);
  return i.update({ embeds: [okEmbed(`Reset XP for ${r.changes} member${Number(r.changes) === 1 ? '' : 's'}.`)], components: [] });
}
