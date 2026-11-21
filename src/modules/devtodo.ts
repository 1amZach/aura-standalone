import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from 'discord.js';
import { all, get, getSettings, run, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, ok, respond, truncate, ts } from '../util.js';
import { throttledEdit } from './polls.js';

const schema = `
create table if not exists devtodo_items (
  id integer primary key autoincrement,
  guild_id text not null,
  num integer not null,
  author_id text not null,
  text text not null,
  files_url text,
  status text not null default 'open',
  note text not null default '',
  updated_by text,
  created_at integer not null,
  updated_at integer not null,
  unique (guild_id, num)
);
create index if not exists devtodo_by_status on devtodo_items (guild_id, status);
`;

export const todoDefaults = {
  channelId: '',
  devRoleId: '',
  boardMessageId: '',
  filesThreadId: '',
  notify: true,
};

export const STATUSES = {
  open: { label: 'Open', emoji: '📝' },
  progress: { label: 'In progress', emoji: '🔧' },
  hold: { label: 'On hold', emoji: '⏸️' },
  info: { label: 'Needs info', emoji: '❓' },
  done: { label: 'Done', emoji: '✅' },
  wont: { label: 'Not doing', emoji: '🚫' },
} as const;
export type Status = keyof typeof STATUSES;
const ACTIVE: Status[] = ['progress', 'open', 'info', 'hold'];
const CLOSED: Status[] = ['done', 'wont'];

export interface TodoItem {
  id: number;
  num: number;
  author_id: string;
  text: string;
  files_url: string | null;
  status: Status;
  note: string;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const line = (t: TodoItem) => {
  const s = STATUSES[t.status];
  const files = t.files_url ? ` [📎](${t.files_url})` : '';
  const note = t.note ? `\n> ${truncate(t.note, 150)}` : '';
  return `${s.emoji} \`#${t.num}\` ${truncate(t.text.replace(/\s+/g, ' '), 180)}${files} · <@${t.author_id}>${note}`;
};

// active items grouped by status, then the last couple of weeks of finished ones
export function renderBoard(items: TodoItem[], now = Date.now()) {
  const sections: string[] = [];
  for (const st of ACTIVE) {
    const list = items.filter((t) => t.status === st).sort((a, b) => a.num - b.num);
    if (list.length) sections.push(`**${STATUSES[st].emoji} ${STATUSES[st].label} (${list.length})**\n${list.map(line).join('\n')}`);
  }
  const recent = items
    .filter((t) => CLOSED.includes(t.status) && now - t.updated_at < 14 * 86400e3)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 15);
  if (recent.length) sections.push(`**Recently finished**\n${recent.map(line).join('\n')}`);

  const embeds = [];
  let chunk = '';
  for (const part of sections.flatMap((s) => s.split('\n'))) {
    if (chunk.length + part.length + 1 > 3900) {
      embeds.push(chunk);
      chunk = '';
    }
    chunk += (chunk ? '\n' : '') + part;
  }
  if (chunk) embeds.push(chunk);

  const open = items.filter((t) => ACTIVE.includes(t.status)).length;
  const out = embeds.slice(0, 9).map((d) => embed(colors.primary).setDescription(d));
  if (!out.length) out.push(embed(colors.primary).setDescription('Nothing on the list. Send a message in this channel to add something.'));
  out[0].setTitle('🛠️ Dev To-Do List');
  out[out.length - 1].setFooter({ text: `${open} open · send a message here to add to the list` }).setTimestamp(now);
  return out;
}

const cfgOf = (db: DB, guildId: string) => getSettings(db, guildId, 'devtodo', todoDefaults);
const isDev = (m: GuildMember, roleId: string) => m.permissions.has(PermissionFlagsBits.ManageGuild) || (!!roleId && m.roles.cache.has(roleId));
const itemsOf = (db: DB, guildId: string) => all<TodoItem>(db, 'select * from devtodo_items where guild_id = ? order by num', guildId);

function boardPayload(db: DB, guildId: string) {
  const items = itemsOf(db, guildId);
  const active = items.filter((t) => ACTIVE.includes(t.status)).slice(-25);
  const components = active.length
    ? [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('td:pick')
            .setPlaceholder('Devs: update an item…')
            .addOptions(active.map((t) => ({ label: truncate(`#${t.num} ${t.text.replace(/\s+/g, ' ')}`, 100), value: String(t.id), emoji: STATUSES[t.status].emoji }))),
        ),
      ]
    : [];
  return { embeds: renderBoard(items), components, allowedMentions: { parse: [] as [] } };
}

async function postBoard(ctx: Ctx, guild: Guild, fresh = false) {
  const cfg = cfgOf(ctx.db, guild.id);
  const channel = guild.channels.cache.get(cfg.channelId) as TextChannel | undefined;
  if (!channel) return;
  const payload = boardPayload(ctx.db, guild.id);
  const old = cfg.boardMessageId ? await channel.messages.fetch(cfg.boardMessageId).catch(() => null) : null;
  if (old && !fresh) {
    await old.edit(payload);
    return;
  }
  await old?.delete().catch(() => {});
  const msg = await channel.send(payload);
  setSettings(ctx.db, guild.id, 'devtodo', todoDefaults, { boardMessageId: msg.id });
}

const refresh = (ctx: Ctx, guild: Guild) => throttledEdit(`todo:${guild.id}`, () => postBoard(ctx, guild));

// short notices in the channel clean themselves up
async function flash(channel: TextChannel, text: string, ms = 6000) {
  const m = await channel.send({ embeds: [embed(colors.muted).setDescription(text)], allowedMentions: { parse: [] } }).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), ms);
}

export function checkSuggestion(text: string, hasFiles: boolean): string | null {
  const clean = text.replace(/<a?:\w+:\d+>|<[@#&!]+\d+>/g, '').trim();
  if (!clean && !hasFiles) return 'Write out what needs doing so the devs know what to look at.';
  if (clean.length < 8 && !hasFiles) return 'That’s a bit short. Add a few more words about what needs doing.';
  if (clean.length > 1500) return 'That’s too long for one item. Split it into a few messages.';
  return null;
}

async function saveFiles(ctx: Ctx, channel: TextChannel, msg: Message, num: number) {
  if (!msg.attachments.size) return null;
  const cfg = cfgOf(ctx.db, channel.guild.id);
  let thread = cfg.filesThreadId ? await channel.threads.fetch(cfg.filesThreadId).catch(() => null) : null;
  if (!thread) {
    thread = await channel.threads.create({ name: '📎 to-do attachments', autoArchiveDuration: 10080, reason: 'Dev to-do attachments' });
    setSettings(ctx.db, channel.guild.id, 'devtodo', todoDefaults, { filesThreadId: thread.id });
  }
  if (thread.archived) await thread.setArchived(false).catch(() => {});
  const copy = await thread.send({
    content: `#${num} from <@${msg.author.id}>`,
    files: [...msg.attachments.values()].slice(0, 10).map((a) => ({ attachment: a.url, name: a.name })),
    allowedMentions: { parse: [] },
  });
  return copy.url;
}

async function setStatus(ctx: Ctx, guild: Guild, item: TodoItem, status: Status, by: string, note?: string | null) {
  run(ctx.db, 'update devtodo_items set status = ?, note = ?, updated_by = ?, updated_at = ? where id = ?', status, note ?? item.note, by, Date.now(), item.id);
  refresh(ctx, guild);
  if (!cfgOf(ctx.db, guild.id).notify || by === item.author_id) return;
  const user = await ctx.client.users.fetch(item.author_id).catch(() => null);
  await user
    ?.send({
      embeds: [
        embed(colors.cyan)
          .setTitle(`${STATUSES[status].emoji} Your request in ${guild.name} is now ${STATUSES[status].label.toLowerCase()}`)
          .setDescription(`> ${truncate(item.text, 500)}${note ? `\n\n**Note:** ${truncate(note, 500)}` : ''}`),
      ],
    })
    .catch(() => {});
}

const statusButtons = (id: number, current: Status) => {
  const keys = Object.keys(STATUSES) as Status[];
  const btn = (s: Status) =>
    new ButtonBuilder()
      .setCustomId(`td:set:${id}:${s}`)
      .setLabel(STATUSES[s].label)
      .setEmoji(STATUSES[s].emoji)
      .setStyle(s === 'done' ? ButtonStyle.Success : s === 'wont' ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(s === current);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(keys.slice(0, 3).map(btn)), new ActionRowBuilder<ButtonBuilder>().addComponents(keys.slice(3).map(btn))];
};

const statusChoices = (Object.keys(STATUSES) as Status[]).map((s) => ({ name: STATUSES[s].label, value: s }));
const numOpt = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('number').setDescription('Item number').setRequired(true).setMinValue(1);

const command = new SlashCommandBuilder()
  .setName('todo')
  .setDescription('Dev to-do list')
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Turn a channel into the to-do list')
      .addChannelOption((o) => o.setName('channel').setDescription('The to-do channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption((o) => o.setName('dev_role').setDescription('Role that can update items (Manage Server always can)'))
      .addBooleanOption((o) => o.setName('notify').setDescription('DM people when their item changes status (default on)')),
  )
  .addSubcommand((s) =>
    s
      .setName('status')
      .setDescription('Change an item’s status')
      .addIntegerOption(numOpt)
      .addStringOption((o) => o.setName('status').setDescription('New status').setRequired(true).addChoices(...statusChoices))
      .addStringOption((o) => o.setName('note').setDescription('Optional note shown under the item').setMaxLength(300)),
  )
  .addSubcommand((s) => s.setName('add').setDescription('Add an item yourself').addStringOption((o) => o.setName('text').setDescription('What needs doing').setRequired(true).setMaxLength(1500)))
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Reword an item')
      .addIntegerOption(numOpt)
      .addStringOption((o) => o.setName('text').setDescription('New text').setRequired(true).setMaxLength(1500)),
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Delete an item from the list').addIntegerOption(numOpt))
  .addSubcommand((s) => s.setName('repost').setDescription('Post the board again at the bottom of the channel'));

const nextNum = (db: DB, guildId: string) => get<{ n: number }>(db, 'select coalesce(max(num), 0) + 1 as n from devtodo_items where guild_id = ?', guildId)!.n;

function addItem(db: DB, guildId: string, authorId: string, text: string, filesUrl: string | null, num = nextNum(db, guildId)) {
  const now = Date.now();
  run(db, 'insert into devtodo_items (guild_id, num, author_id, text, files_url, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)', guildId, num, authorId, text, filesUrl, now, now);
  return num;
}

export const devtodoModule: Module = {
  id: 'devtodo',
  name: 'Dev To-Do List',
  description: 'A channel where anyone can drop requests for the devs. Aura files each one on a live board and devs update the status.',
  defaultOn: false,
  schema,
  commands: [command.toJSON()],
  handle: {
    async todo(i, ctx) {
      const { db } = ctx;
      const sub = i.options.getSubcommand();
      const cfg = cfgOf(db, i.guildId);

      if (sub === 'setup') {
        if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server to set this up.');
        const ch = i.options.getChannel('channel', true) as TextChannel;
        const me = i.guild.members.me!;
        if (!ch.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.CreatePublicThreads]))
          return fail(i, `I need Send Messages, Manage Messages, Embed Links and Create Public Threads in <#${ch.id}>.`);
        const role = i.options.getRole('dev_role');
        setSettings(db, i.guildId, 'devtodo', todoDefaults, {
          channelId: ch.id,
          devRoleId: role?.id ?? cfg.devRoleId,
          notify: i.options.getBoolean('notify') ?? cfg.notify,
          boardMessageId: ch.id === cfg.channelId ? cfg.boardMessageId : '',
        });
        await postBoard(ctx, i.guild, true);
        return ok(i, `<#${ch.id}> is now the dev to-do list. Messages sent there get added to the board and cleaned up.`);
      }

      if (!cfg.channelId) return fail(i, 'The to-do list isn’t set up yet. Run `/todo setup` first.');
      if (!isDev(i.member, cfg.devRoleId)) return fail(i, 'Only devs can manage the to-do list.');

      if (sub === 'repost') {
        await postBoard(ctx, i.guild, true);
        return ok(i, 'Board reposted.');
      }
      if (sub === 'add') {
        const num = addItem(db, i.guildId, i.user.id, i.options.getString('text', true).trim(), null);
        refresh(ctx, i.guild);
        return ok(i, `Added #${num}.`);
      }

      const num = i.options.getInteger('number', true);
      const item = get<TodoItem>(db, 'select * from devtodo_items where guild_id = ? and num = ?', i.guildId, num);
      if (!item) return fail(i, `There’s no item #${num}.`);

      if (sub === 'status') {
        const status = i.options.getString('status', true) as Status;
        await setStatus(ctx, i.guild, item, status, i.user.id, i.options.getString('note'));
        return ok(i, `#${num} is now ${STATUSES[status].emoji} ${STATUSES[status].label}.`);
      }
      if (sub === 'edit') {
        run(db, 'update devtodo_items set text = ?, updated_at = ? where id = ?', i.options.getString('text', true).trim(), Date.now(), item.id);
        refresh(ctx, i.guild);
        return ok(i, `Updated #${num}.`);
      }
      run(db, 'delete from devtodo_items where id = ?', item.id);
      refresh(ctx, i.guild);
      return ok(i, `Removed #${num}.`);
    },
  },
  components: {
    async td(i, args, ctx) {
      if (!i.inCachedGuild()) return;
      const cfg = cfgOf(ctx.db, i.guildId);
      if (!isDev(i.member, cfg.devRoleId)) return fail(i, 'Only devs can update items.');

      if (args[0] === 'pick' && i.isStringSelectMenu()) {
        const item = get<TodoItem>(ctx.db, 'select * from devtodo_items where guild_id = ? and id = ?', i.guildId, Number(i.values[0]));
        if (!item) return fail(i, 'That item’s gone.');
        // reset the menu so the same item can be picked again
        await i.message.edit(boardPayload(ctx.db, i.guildId)).catch(() => {});
        return i.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            embed(colors.cyan)
              .setTitle(`#${item.num} · ${STATUSES[item.status].emoji} ${STATUSES[item.status].label}`)
              .setDescription(truncate(item.text, 3000))
              .addFields({ name: 'From', value: `<@${item.author_id}> · ${ts(item.created_at, 'R')}` }),
          ],
          components: statusButtons(item.id, item.status),
        });
      }

      if (args[0] === 'set' && i.isButton()) {
        const item = get<TodoItem>(ctx.db, 'select * from devtodo_items where guild_id = ? and id = ?', i.guildId, Number(args[1]));
        const status = args[2] as Status;
        if (!item || !STATUSES[status]) return fail(i, 'That item’s gone.');
        await setStatus(ctx, i.guild, item, status, i.user.id);
        return i.update({ embeds: [embed(colors.success).setDescription(`#${item.num} is now ${STATUSES[status].emoji} ${STATUSES[status].label}.`)], components: [] });
      }
    },
  },
  init(ctx) {
    ctx.client.on(Events.MessageCreate, async (msg) => {
      try {
        if (!msg.inGuild() || msg.author.bot || msg.system || !ctx.enabled(msg.guildId, 'devtodo')) return;
        const cfg = cfgOf(ctx.db, msg.guildId);
        if (msg.channelId !== cfg.channelId) return;
        const channel = msg.channel as TextChannel;

        const problem = checkSuggestion(msg.content, msg.attachments.size > 0);
        if (problem) {
          await flash(channel, `<@${msg.author.id}>, ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
          setTimeout(() => msg.delete().catch(() => {}), 4000);
          return;
        }
        const dupe = get<{ num: number }>(
          ctx.db,
          "select num from devtodo_items where guild_id = ? and lower(text) = lower(?) and status not in ('done', 'wont')",
          msg.guildId,
          msg.content.trim(),
        );
        if (dupe) {
          await flash(channel, `<@${msg.author.id}>, that’s already on the list as #${dupe.num}.`);
          setTimeout(() => msg.delete().catch(() => {}), 4000);
          return;
        }

        const num = nextNum(ctx.db, msg.guildId);
        const files = await saveFiles(ctx, channel, msg, num).catch(() => null);
        addItem(ctx.db, msg.guildId, msg.author.id, msg.content.trim() || 'See attachments', files, num);
        await msg.react('✅').catch(() => {});
        await flash(channel, `✅ Added to the list as **#${num}**, thanks <@${msg.author.id}>.`);
        setTimeout(() => msg.delete().catch(() => {}), 4000);
        refresh(ctx, msg.guild);
      } catch (e) {
        console.warn('[devtodo]', e instanceof Error ? e.message : e);
      }
    });
  },
};
