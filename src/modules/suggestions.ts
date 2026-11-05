import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type GuildTextBasedChannel,
  type SlashCommandIntegerOption,
} from 'discord.js';
import { get, getSettings, run, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, ok, respond, truncate, ts } from '../util.js';
import { throttledEdit } from './polls.js';

const schema = `
create table if not exists suggestions_list (
  id integer primary key autoincrement,
  guild_id text not null,
  num integer not null,
  channel_id text not null,
  message_id text,
  thread_id text,
  author_id text not null,
  author_name text not null,
  author_avatar text,
  content text not null,
  status text not null default 'pending',
  reason text not null default '',
  reviewer_id text,
  created_at integer not null,
  unique (guild_id, num)
);
create index if not exists suggestions_by_author on suggestions_list (guild_id, author_id, created_at);
create table if not exists suggestions_votes (
  suggestion_id integer not null references suggestions_list (id) on delete cascade,
  user_id text not null,
  value integer not null,
  primary key (suggestion_id, user_id)
);
`;

export const suggestionDefaults = {
  channelId: '',
  reviewRoleId: '',
  threads: false,
};

type Status = 'pending' | 'approved' | 'denied' | 'considering' | 'implemented';

const STATUS: Record<Status, { label: string; emoji: string; color: number; closed: boolean }> = {
  pending: { label: 'Open for votes', emoji: '🗳️', color: colors.primary, closed: false },
  considering: { label: 'Being considered', emoji: '🤔', color: colors.cyan, closed: false },
  approved: { label: 'Approved', emoji: '✅', color: colors.success, closed: true },
  denied: { label: 'Denied', emoji: '❌', color: colors.danger, closed: true },
  implemented: { label: 'Implemented', emoji: '🚀', color: colors.blue, closed: true },
};

const COOLDOWN_MS = 2 * 60e3;

interface Suggestion {
  id: number;
  guild_id: string;
  num: number;
  channel_id: string;
  message_id: string | null;
  thread_id: string | null;
  author_id: string;
  author_name: string;
  author_avatar: string | null;
  content: string;
  status: Status;
  reason: string;
  reviewer_id: string | null;
  created_at: number;
}

function counts(db: DB, id: number) {
  const r = get<{ up: number; down: number }>(
    db,
    'select coalesce(sum(value = 1), 0) as up, coalesce(sum(value = -1), 0) as down from suggestions_votes where suggestion_id = ?',
    id,
  );
  return { up: r?.up ?? 0, down: r?.down ?? 0 };
}

function view(db: DB, s: Suggestion) {
  const st = STATUS[s.status];
  const { up, down } = counts(db, s.id);
  const e = embed(st.color)
    .setAuthor({ name: s.author_name, iconURL: s.author_avatar ?? undefined })
    .setTitle(`Suggestion #${s.num}`)
    .setDescription(truncate(s.content, 4000))
    .addFields({ name: 'Status', value: `${st.emoji} ${st.label}`, inline: true }, { name: 'Votes', value: `👍 ${up} · 👎 ${down}`, inline: true })
    .setFooter({ text: `From ${s.author_name}` })
    .setTimestamp(s.created_at);
  if (s.reviewer_id) e.addFields({ name: s.reason ? 'Reason from the team' : 'Reviewed by', value: s.reason ? `${truncate(s.reason, 1000)}\n- <@${s.reviewer_id}>` : `<@${s.reviewer_id}>` });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sg:vote:${s.id}:up`).setEmoji('👍').setLabel(String(up)).setStyle(ButtonStyle.Success).setDisabled(st.closed),
    new ButtonBuilder().setCustomId(`sg:vote:${s.id}:down`).setEmoji('👎').setLabel(String(down)).setStyle(ButtonStyle.Danger).setDisabled(st.closed),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

async function redraw(ctx: Ctx, id: number) {
  const s = get<Suggestion>(ctx.db, 'select * from suggestions_list where id = ?', id);
  if (!s?.message_id) return;
  const ch = await ctx.client.channels.fetch(s.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(s.message_id).catch(() => null);
  if (msg) await msg.edit(view(ctx.db, s));
}

const numOpt = (o: SlashCommandIntegerOption) => o.setName('number').setDescription('Suggestion number').setMinValue(1).setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName('suggest')
    .setDescription('Share an idea for the server')
    .addStringOption((o) => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMinLength(5).setMaxLength(2000)),
  (() => {
    const b = new SlashCommandBuilder()
      .setName('suggestion')
      .setDescription('Set up and review suggestions')
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Pick where suggestions go')
          .addChannelOption((o) => o.setName('channel').setDescription('Suggestions channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
          .addRoleOption((o) => o.setName('review_role').setDescription('Role that can approve and deny (Manage Server always can)'))
          .addBooleanOption((o) => o.setName('threads').setDescription('Open a discussion thread on each suggestion')),
      );
    for (const [name, desc] of [
      ['approve', 'Approve a suggestion'],
      ['deny', 'Deny a suggestion'],
      ['consider', 'Mark a suggestion as being considered'],
      ['implemented', 'Mark a suggestion as done'],
    ] as const) {
      b.addSubcommand((s) =>
        s
          .setName(name)
          .setDescription(desc)
          .addIntegerOption(numOpt)
          .addStringOption((o) => o.setName('reason').setDescription('Shown on the suggestion and sent to the author').setMaxLength(1000)),
      );
    }
    return b;
  })(),
];

const VERB: Record<string, Status> = { approve: 'approved', deny: 'denied', consider: 'considering', implemented: 'implemented' };

export const suggestionsModule: Module = {
  id: 'suggestions',
  name: 'Suggestions',
  description: 'A suggestions channel with voting, optional threads, and approve or deny with reasons.',
  defaultOn: false,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async suggest(i, { db }) {
      const cfg = getSettings(db, i.guildId, 'suggestions', suggestionDefaults);
      if (!cfg.channelId) return fail(i, 'Suggestions aren’t set up yet. An admin can run `/suggestion setup`.');
      const ch = i.guild.channels.cache.get(cfg.channelId) as GuildTextBasedChannel | undefined;
      if (!ch?.isSendable()) return fail(i, 'The suggestions channel is missing or I can’t post there. Ask an admin to run `/suggestion setup` again.');

      const last = get<{ at: number }>(db, 'select max(created_at) as at from suggestions_list where guild_id = ? and author_id = ?', i.guildId, i.user.id)?.at ?? 0;
      if (Date.now() - last < COOLDOWN_MS) return fail(i, `Slow down a little. You can suggest again ${ts(last + COOLDOWN_MS, 'R')}.`);

      const num = get<{ n: number }>(db, 'select coalesce(max(num), 0) + 1 as n from suggestions_list where guild_id = ?', i.guildId)?.n ?? 1;
      const content = i.options.getString('idea', true);
      const res = run(
        db,
        'insert into suggestions_list (guild_id, num, channel_id, author_id, author_name, author_avatar, content, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        i.guildId, num, ch.id, i.user.id, i.member.displayName, i.user.displayAvatarURL(), content, Date.now(),
      );
      const id = Number(res.lastInsertRowid);
      const s = get<Suggestion>(db, 'select * from suggestions_list where id = ?', id)!;
      const msg = await ch.send(view(db, s)).catch(() => null);
      if (!msg) {
        run(db, 'delete from suggestions_list where id = ?', id);
        return fail(i, `I couldn’t post in <#${ch.id}>. Check I can send messages and embed links there.`);
      }
      run(db, 'update suggestions_list set message_id = ? where id = ?', msg.id, id);
      if (cfg.threads) {
        const thread = await msg.startThread({ name: truncate(`#${num} ${content.replace(/\s+/g, ' ')}`, 90), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek }).catch(() => null);
        if (thread) run(db, 'update suggestions_list set thread_id = ? where id = ?', thread.id, id);
      }
      return ok(i, `Thanks! Your idea is up as [suggestion #${num}](${msg.url}).`);
    },

    async suggestion(i, ctx) {
      const { db } = ctx;
      const sub = i.options.getSubcommand();
      const cfg = getSettings(db, i.guildId, 'suggestions', suggestionDefaults);
      const isManager = i.memberPermissions.has(PermissionFlagsBits.ManageGuild);

      if (sub === 'setup') {
        if (!isManager) return fail(i, 'You need **Manage Server** to set up suggestions.');
        const ch = i.options.getChannel('channel', true) as GuildTextBasedChannel;
        const me = i.guild.members.me;
        if (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
          return fail(i, `I need **Send Messages** and **Embed Links** in <#${ch.id}>.`);
        const role = i.options.getRole('review_role');
        const threads = i.options.getBoolean('threads');
        const next = setSettings(db, i.guildId, 'suggestions', suggestionDefaults, {
          channelId: ch.id,
          ...(role ? { reviewRoleId: role.id } : {}),
          ...(threads !== null ? { threads } : {}),
        });
        const notes = [`Suggestions go to <#${ch.id}>.`];
        if (next.reviewRoleId) notes.push(`<@&${next.reviewRoleId}> can review them.`);
        notes.push(next.threads ? 'Each one gets a discussion thread.' : 'No discussion threads.');
        if (!ctx.enabled(i.guildId, 'suggestions')) notes.push('Turn the module on with `/module enable suggestions` when you’re ready.');
        return ok(i, notes.join(' '));
      }

      if (!isManager && !(cfg.reviewRoleId && i.member.roles.cache.has(cfg.reviewRoleId)))
        return fail(i, 'Only staff with **Manage Server** or the review role can do that.');
      const num = i.options.getInteger('number', true);
      const s = get<Suggestion>(db, 'select * from suggestions_list where guild_id = ? and num = ?', i.guildId, num);
      if (!s) return fail(i, `There’s no suggestion #${num}.`);
      const status = VERB[sub];
      const reason = i.options.getString('reason') ?? '';
      run(db, 'update suggestions_list set status = ?, reason = ?, reviewer_id = ? where id = ?', status, reason, i.user.id, s.id);
      await redraw(ctx, s.id).catch((e) => console.warn(`[suggestions] redraw ${s.id}:`, e instanceof Error ? e.message : e));

      const st = STATUS[status];
      const author = await ctx.client.users.fetch(s.author_id).catch(() => null);
      await author
        ?.send({
          embeds: [
            embed(st.color)
              .setTitle(`${st.emoji} Your suggestion in ${i.guild.name}: ${st.label.toLowerCase()}`)
              .setDescription(`> ${truncate(s.content, 500).replace(/\n/g, '\n> ')}${reason ? `\n\n**Reason:** ${reason}` : ''}`),
          ],
        })
        .catch(() => {});
      return ok(i, `Suggestion #${num} is now **${st.label.toLowerCase()}**.`);
    },
  },
  components: {
    async sg(i, [, rawId, dir], ctx) {
      if (!i.isButton()) return;
      const { db } = ctx;
      const s = get<Suggestion>(db, 'select * from suggestions_list where id = ?', Number(rawId));
      if (!s) return fail(i, 'This suggestion doesn’t exist anymore.');
      if (STATUS[s.status].closed) return fail(i, 'Voting on this one is closed.');
      const value = dir === 'up' ? 1 : -1;
      const current = get<{ value: number }>(db, 'select value from suggestions_votes where suggestion_id = ? and user_id = ?', s.id, i.user.id)?.value;
      let reply: string;
      if (current === value) {
        run(db, 'delete from suggestions_votes where suggestion_id = ? and user_id = ?', s.id, i.user.id);
        reply = 'Removed your vote.';
      } else {
        run(db, 'insert into suggestions_votes (suggestion_id, user_id, value) values (?, ?, ?) on conflict (suggestion_id, user_id) do update set value = excluded.value', s.id, i.user.id, value);
        reply = value === 1 ? 'You voted 👍' : 'You voted 👎';
      }
      throttledEdit(`sg:${s.id}`, () => redraw(ctx, s.id));
      return respond(i, { embeds: [embed(colors.success).setDescription(reply)] });
    },
  },
};
