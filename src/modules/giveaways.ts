import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type Guild, type SlashCommandIntegerOption, type GuildTextBasedChannel } from 'discord.js';
import { all, get, run, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, fmtDuration, ok, okEmbed, parseDuration, pickRandom, respond, truncate, ts } from '../util.js';
import { throttledEdit } from './polls.js';

export function pickWinners(entries: string[], n: number, exclude: Iterable<string> = []): string[] {
  const skip = new Set(exclude);
  return pickRandom([...new Set(entries)].filter((id) => !skip.has(id)), n);
}

const schema = `
create table if not exists giveaways_list (
  id integer primary key autoincrement,
  guild_id text not null,
  channel_id text not null,
  message_id text,
  host_id text not null,
  prize text not null,
  description text not null default '',
  winners integer not null default 1,
  required_role text,
  min_age_days integer not null default 0,
  ends_at integer not null,
  ended integer not null default 0,
  cancelled integer not null default 0,
  winner_ids text not null default '',
  created_at integer not null
);
create index if not exists giveaways_open on giveaways_list (ends_at) where ended = 0;
create table if not exists giveaways_entries (
  giveaway_id integer not null references giveaways_list (id) on delete cascade,
  user_id text not null,
  entered_at integer not null,
  primary key (giveaway_id, user_id)
);
`;

interface Giveaway {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  prize: string;
  description: string;
  winners: number;
  required_role: string | null;
  min_age_days: number;
  ends_at: number;
  ended: number;
  cancelled: number;
  winner_ids: string;
  created_at: number;
}

const load = (db: DB, id: number) => get<Giveaway>(db, 'select * from giveaways_list where id = ?', id);
const entryCount = (db: DB, id: number) => get<{ n: number }>(db, 'select count(*) as n from giveaways_entries where giveaway_id = ?', id)?.n ?? 0;
const winnersOf = (g: Giveaway) => g.winner_ids.split(',').filter(Boolean);
const link = (g: Giveaway) => `https://discord.com/channels/${g.guild_id}/${g.channel_id}/${g.message_id}`;

function view(db: DB, g: Giveaway) {
  const entries = entryCount(db, g.id);
  const lines: string[] = g.description ? [g.description, ''] : [];
  if (g.cancelled) lines.push('This giveaway was cancelled.');
  else if (g.ended) {
    const w = winnersOf(g);
    lines.push(w.length ? `**Winner${w.length === 1 ? '' : 's'}:** ${w.map((id) => `<@${id}>`).join(', ')}` : 'Nobody valid entered, so there’s no winner.');
    lines.push(`**Ended:** ${ts(g.ends_at, 'R')}`);
  } else {
    lines.push(`**Ends:** ${ts(g.ends_at, 'R')} (${ts(g.ends_at, 'f')})`);
    lines.push(`**Winners:** ${g.winners}`);
  }
  lines.push(`**Hosted by:** <@${g.host_id}>`, `**Entries:** ${entries}`);
  const reqs = [g.required_role && `Have the <@&${g.required_role}> role`, g.min_age_days && `Account at least ${g.min_age_days} day${g.min_age_days === 1 ? '' : 's'} old`].filter(Boolean);
  if (reqs.length && !g.ended) lines.push('', `**Requirements**\n${reqs.map((r) => `• ${r}`).join('\n')}`);

  const e = embed(g.cancelled ? colors.muted : g.ended ? colors.success : colors.primary)
    .setTitle(`🎉 ${truncate(g.prize, 240)}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Giveaway #${g.id}` })
    .setTimestamp(g.ends_at);
  const button = new ButtonBuilder()
    .setCustomId(`gw:enter:${g.id}`)
    .setEmoji('🎉')
    .setLabel(g.ended ? (g.cancelled ? 'Cancelled' : 'Ended') : `Enter (${entries})`)
    .setStyle(g.ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(!!g.ended);
  return { embeds: [e], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)], allowedMentions: { parse: [] } };
}

async function channelOf(ctx: Ctx, g: Giveaway) {
  const ch = await ctx.client.channels.fetch(g.channel_id).catch(() => null);
  return ch?.isTextBased() && !ch.isDMBased() ? (ch as GuildTextBasedChannel) : null;
}

async function redraw(ctx: Ctx, id: number) {
  const g = load(ctx.db, id);
  if (!g?.message_id) return;
  const ch = await channelOf(ctx, g);
  const msg = await ch?.messages.fetch(g.message_id).catch(() => null);
  if (msg) await msg.edit(view(ctx.db, g));
}

// Shuffles everyone, then walks the list until we have enough people who are still in the server.
async function draw(guild: Guild, db: DB, g: Giveaway, n: number, exclude: string[] = []) {
  const entries = all<{ user_id: string }>(db, 'select user_id from giveaways_entries where giveaway_id = ?', g.id).map((r) => r.user_id);
  const order = pickWinners(entries, entries.length, exclude);
  const out: string[] = [];
  for (const id of order) {
    if (out.length >= n) break;
    const m = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
    if (m) out.push(id);
  }
  return out;
}

async function announce(ctx: Ctx, g: Giveaway, winners: string[], reroll = false) {
  const ch = await channelOf(ctx, g);
  if (!ch) return;
  const names = winners.map((id) => `<@${id}>`).join(', ');
  const content = winners.length
    ? `🎉 ${reroll ? `New pick: ${names}` : `Congrats ${names}`}! You won **${truncate(g.prize, 200)}**.`
    : `Nobody valid entered the **${truncate(g.prize, 200)}** giveaway, so there’s no winner.`;
  await ch.send({
    content,
    allowedMentions: { users: winners },
    reply: g.message_id ? { messageReference: g.message_id, failIfNotExists: false } : undefined,
  });
}

async function finish(ctx: Ctx, g: Giveaway) {
  run(ctx.db, 'update giveaways_list set ended = 1, ends_at = min(ends_at, ?) where id = ?', Date.now(), g.id);
  const guild = ctx.client.guilds.cache.get(g.guild_id);
  const winners = guild ? await draw(guild, ctx.db, g, g.winners) : [];
  run(ctx.db, 'update giveaways_list set winner_ids = ? where id = ?', winners.join(','), g.id);
  const fresh = load(ctx.db, g.id)!;
  await redraw(ctx, g.id).catch(() => {});
  await announce(ctx, fresh, winners).catch((e) => console.warn(`[giveaways] announce ${g.id}:`, e instanceof Error ? e.message : e));
  return winners;
}

const idOpt = (o: SlashCommandIntegerOption) => o.setName('id').setDescription('Giveaway number (in its footer)').setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Start a giveaway')
        .addStringOption((o) => o.setName('prize').setDescription('What they win').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duration').setDescription('How long, e.g. 1h, 2d, 1w').setRequired(true))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many winners').setMinValue(1).setMaxValue(20).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((o) => o.setName('required_role').setDescription('Only people with this role can enter'))
        .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Accounts must be at least this many days old').setMinValue(1).setMaxValue(3650))
        .addStringOption((o) => o.setName('description').setDescription('Extra details').setMaxLength(1000)),
    )
    .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and pick winners').addIntegerOption(idOpt))
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Pick new winners for an ended giveaway')
        .addIntegerOption(idOpt)
        .addIntegerOption((o) => o.setName('winners').setDescription('How many to pick (default 1)').setMinValue(1).setMaxValue(20)),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a giveaway with no winners').addIntegerOption(idOpt))
    .addSubcommand((s) => s.setName('list').setDescription('Running giveaways in this server')),
];

export const giveawaysModule: Module = {
  id: 'giveaways',
  name: 'Giveaways',
  description: 'Button giveaways with entry requirements, auto-ending, rerolls and winner pings.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async giveaway(i, ctx) {
      const { db } = ctx;
      const sub = i.options.getSubcommand();

      if (sub === 'list') {
        const rows = all<Giveaway>(db, 'select * from giveaways_list where guild_id = ? and ended = 0 order by ends_at asc limit 25', i.guildId);
        const lines = rows.map((g) => `\`#${g.id}\` [${truncate(g.prize, 80)}](${link(g)}) · ends ${ts(g.ends_at, 'R')} · ${entryCount(db, g.id)} entries`);
        return respond(i, { embeds: [embed().setTitle('Running giveaways').setDescription(lines.join('\n') || 'No giveaways running right now.')] });
      }

      if (sub === 'start') {
        const ms = parseDuration(i.options.getString('duration', true));
        if (!ms || ms < 10e3 || ms > 60 * 86400e3) return fail(i, 'Give a length like `1h`, `2d` or `1w`, up to 60 days.');
        const ch = (i.options.getChannel('channel') ?? i.channel) as GuildTextBasedChannel | null;
        if (!ch?.isSendable()) return fail(i, 'I can’t post there.');
        const me = i.guild.members.me;
        if (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
          return fail(i, `I need **Send Messages** and **Embed Links** in <#${ch.id}>.`);

        const now = Date.now();
        const res = run(
          db,
          'insert into giveaways_list (guild_id, channel_id, host_id, prize, description, winners, required_role, min_age_days, ends_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          i.guildId, ch.id, i.user.id, i.options.getString('prize', true), i.options.getString('description') ?? '', i.options.getInteger('winners', true),
          i.options.getRole('required_role')?.id ?? null, i.options.getInteger('min_account_age_days') ?? 0, now + ms, now,
        );
        const id = Number(res.lastInsertRowid);
        const msg = await ch.send(view(db, load(db, id)!)).catch(() => null);
        if (!msg) {
          run(db, 'delete from giveaways_list where id = ?', id);
          return fail(i, `I couldn’t post in <#${ch.id}>.`);
        }
        run(db, 'update giveaways_list set message_id = ? where id = ?', msg.id, id);
        return ok(i, `Giveaway #${id} is live in <#${ch.id}> and ends in ${fmtDuration(ms)}.`);
      }

      const g = load(db, i.options.getInteger('id', true));
      if (!g || g.guild_id !== i.guildId) return fail(i, 'I couldn’t find that giveaway.');

      if (sub === 'end') {
        if (g.ended) return fail(i, 'That giveaway has already ended.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const w = await finish(ctx, g);
        return ok(i, w.length ? `Ended giveaway #${g.id}. Winner${w.length === 1 ? '' : 's'}: ${w.map((id) => `<@${id}>`).join(', ')}` : `Ended giveaway #${g.id}, but nobody valid entered.`);
      }
      if (sub === 'cancel') {
        if (g.ended) return fail(i, 'That giveaway has already ended.');
        run(db, 'update giveaways_list set ended = 1, cancelled = 1 where id = ?', g.id);
        await redraw(ctx, g.id).catch(() => {});
        return ok(i, `Cancelled giveaway #${g.id}.`);
      }
      if (!g.ended || g.cancelled) return fail(i, g.cancelled ? 'That giveaway was cancelled.' : 'That giveaway is still running. End it first.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const prev = winnersOf(g);
      const picked = await draw(i.guild, db, g, i.options.getInteger('winners') ?? 1, prev);
      if (!picked.length) return fail(i, 'There’s nobody left to pick.');
      run(db, 'update giveaways_list set winner_ids = ? where id = ?', [...prev, ...picked].join(','), g.id);
      await redraw(ctx, g.id).catch(() => {});
      await announce(ctx, g, picked, true).catch(() => {});
      return ok(i, `Rerolled: ${picked.map((id) => `<@${id}>`).join(', ')}`);
    },
  },
  components: {
    async gw(i, [action, rawId], ctx) {
      if (!i.isButton() || !i.inCachedGuild()) return;
      const { db } = ctx;
      const g = load(db, Number(rawId));
      if (!g) return fail(i, 'This giveaway doesn’t exist anymore.');
      if (g.ended || g.ends_at <= Date.now()) return fail(i, 'This giveaway has ended.');
      const entered = !!get(db, 'select 1 as x from giveaways_entries where giveaway_id = ? and user_id = ?', g.id, i.user.id);

      if (action === 'leave') {
        if (entered) run(db, 'delete from giveaways_entries where giveaway_id = ? and user_id = ?', g.id, i.user.id);
        throttledEdit(`gw:${g.id}`, () => redraw(ctx, g.id));
        return i.update({ embeds: [okEmbed('You’ve left the giveaway.')], components: [] });
      }
      if (entered) {
        return respond(i, {
          embeds: [embed(colors.blue).setDescription('You’re already in this giveaway. Want to leave?')],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`gw:leave:${g.id}`).setLabel('Leave giveaway').setStyle(ButtonStyle.Danger))],
        });
      }
      if (g.required_role && !i.member.roles.cache.has(g.required_role)) return fail(i, `You need the <@&${g.required_role}> role to enter this one.`);
      if (g.min_age_days) {
        const readyAt = i.user.createdTimestamp + g.min_age_days * 86400e3;
        if (readyAt > Date.now()) return fail(i, `Your account needs to be at least ${g.min_age_days} day${g.min_age_days === 1 ? '' : 's'} old to enter. You’ll be eligible ${ts(readyAt, 'R')}.`);
      }
      run(db, 'insert or ignore into giveaways_entries (giveaway_id, user_id, entered_at) values (?, ?, ?)', g.id, i.user.id, Date.now());
      throttledEdit(`gw:${g.id}`, () => redraw(ctx, g.id));
      return ok(i, 'You’re in. Good luck!');
    },
  },
  async tick(ctx) {
    const due = all<Giveaway>(ctx.db, 'select * from giveaways_list where ended = 0 and ends_at <= ?', Date.now());
    for (const g of due) {
      try {
        await finish(ctx, g);
      } catch (e) {
        console.warn(`[giveaways] end ${g.id}:`, e instanceof Error ? e.message : e);
      }
    }
  },
};
