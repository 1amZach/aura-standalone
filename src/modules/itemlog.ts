import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type GuildMember } from 'discord.js';
import { all, get, getSettings, run, setSettings } from '../db.js';
import type { Module } from '../types.js';
import { colors, embed, fail, ok, respond, truncate, ts } from '../util.js';

const schema = `
create table if not exists itemlog_entries (
  id integer primary key autoincrement,
  guild_id text not null,
  num integer not null,
  staff_id text not null,
  player text not null,
  items text not null,
  reason text not null,
  authorized_by text not null,
  channel_id text,
  message_id text,
  removed integer not null default 0,
  created_at integer not null,
  unique (guild_id, num)
);
create index if not exists itemlog_by_player on itemlog_entries (guild_id, player collate nocase);
`;

export const itemlogDefaults = { channelId: '', staffRoleId: '' };

interface Entry {
  id: number;
  num: number;
  staff_id: string;
  player: string;
  items: string;
  reason: string;
  authorized_by: string;
  channel_id: string | null;
  message_id: string | null;
  removed: number;
  created_at: number;
}

export function entryEmbed(e: Pick<Entry, 'num' | 'staff_id' | 'player' | 'items' | 'reason' | 'authorized_by' | 'created_at'>) {
  return embed(colors.cyan)
    .setTitle(`📦 Given Items Log #${e.num}`)
    .addFields(
      { name: 'Staff Member', value: `<@${e.staff_id}>`, inline: true },
      { name: 'Player Name', value: truncate(e.player, 1024), inline: true },
      { name: 'Authorized By', value: `<@${e.authorized_by}>`, inline: true },
      { name: 'Item(s) & Amount', value: truncate(e.items, 1024) },
      { name: 'Reason for Giving', value: truncate(e.reason, 1024) },
    )
    .setFooter({ text: 'Given Items Log' })
    .setTimestamp(e.created_at);
}

const isStaff = (m: GuildMember, roleId: string) => m.permissions.has(PermissionFlagsBits.ManageMessages) || (!!roleId && m.roles.cache.has(roleId));

const command = new SlashCommandBuilder()
  .setName('itemlog')
  .setDescription('Log items given to players')
  .addSubcommand((s) =>
    s
      .setName('give')
      .setDescription('Log items you gave a player')
      .addStringOption((o) => o.setName('player').setDescription('Player name').setRequired(true).setMaxLength(100))
      .addStringOption((o) => o.setName('items').setDescription('Item(s) and amount, e.g. 2x Medkit, $5,000 cash').setRequired(true).setMaxLength(1000))
      .addStringOption((o) => o.setName('reason').setDescription('Why they were given').setRequired(true).setMaxLength(1000))
      .addUserOption((o) => o.setName('authorized_by').setDescription('Who signed off on it').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('history')
      .setDescription('Recent entries, optionally for one player or staff member')
      .addStringOption((o) => o.setName('player').setDescription('Player name'))
      .addUserOption((o) => o.setName('staff').setDescription('Staff member who gave them')),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a wrong entry')
      .addIntegerOption((o) => o.setName('number').setDescription('Entry number').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Pick the log channel and who can log items')
      .addChannelOption((o) => o.setName('channel').setDescription('Where entries are posted').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption((o) => o.setName('staff_role').setDescription('Role allowed to log items (Manage Messages always can)')),
  );

export const itemlogModule: Module = {
  id: 'itemlog',
  name: 'Given Items Log',
  description: 'Staff log items handed out to players, who signed off on it, and why.',
  defaultOn: false,
  schema,
  commands: [command.toJSON()],
  handle: {
    async itemlog(i, { db }) {
      const sub = i.options.getSubcommand();
      const cfg = getSettings(db, i.guildId, 'itemlog', itemlogDefaults);

      if (sub === 'setup') {
        if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server to set this up.');
        const ch = i.options.getChannel('channel', true);
        const role = i.options.getRole('staff_role');
        setSettings(db, i.guildId, 'itemlog', itemlogDefaults, { channelId: ch.id, staffRoleId: role?.id ?? '' });
        return ok(i, `Item logs go to <#${ch.id}>.${role ? ` <@&${role.id}> can log items.` : ''}`);
      }

      if (!isStaff(i.member, cfg.staffRoleId)) return fail(i, 'Only staff can use the item log.');

      if (sub === 'give') {
        if (!cfg.channelId) return fail(i, 'No log channel yet. An admin needs to run `/itemlog setup` first.');
        const channel = i.guild.channels.cache.get(cfg.channelId);
        if (!channel?.isTextBased()) return fail(i, 'The log channel is gone. Run `/itemlog setup` again.');
        const num = get<{ n: number }>(db, 'select coalesce(max(num), 0) + 1 as n from itemlog_entries where guild_id = ?', i.guildId)!.n;
        const entry = {
          num,
          staff_id: i.user.id,
          player: i.options.getString('player', true).trim(),
          items: i.options.getString('items', true).trim(),
          reason: i.options.getString('reason', true).trim(),
          authorized_by: i.options.getUser('authorized_by', true).id,
          created_at: Date.now(),
        };
        const msg = await channel.send({ embeds: [entryEmbed(entry)], allowedMentions: { parse: [] } }).catch(() => null);
        if (!msg) return fail(i, `I couldn’t post in <#${channel.id}>. Check I can send messages and embeds there.`);
        run(
          db,
          'insert into itemlog_entries (guild_id, num, staff_id, player, items, reason, authorized_by, channel_id, message_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          i.guildId, num, entry.staff_id, entry.player, entry.items, entry.reason, entry.authorized_by, channel.id, msg.id, entry.created_at,
        );
        return ok(i, `Logged as entry #${num} in <#${channel.id}>.`);
      }

      if (sub === 'remove') {
        const num = i.options.getInteger('number', true);
        const e = get<Entry>(db, 'select * from itemlog_entries where guild_id = ? and num = ? and removed = 0', i.guildId, num);
        if (!e) return fail(i, `There’s no entry #${num}.`);
        if (e.staff_id !== i.user.id && !i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You can only remove your own entries.');
        run(db, 'update itemlog_entries set removed = 1 where id = ?', e.id);
        const ch = e.channel_id ? i.guild.channels.cache.get(e.channel_id) : null;
        if (ch?.isTextBased() && e.message_id) {
          const m = await ch.messages.fetch(e.message_id).catch(() => null);
          await m?.edit({ embeds: [entryEmbed(e).setColor(colors.muted).setTitle(`📦 Given Items Log #${e.num} (removed by ${i.user.username})`)] }).catch(() => {});
        }
        return ok(i, `Removed entry #${num}.`);
      }

      const player = i.options.getString('player')?.trim();
      const staff = i.options.getUser('staff');
      let sql = 'select * from itemlog_entries where guild_id = ? and removed = 0';
      const params: string[] = [i.guildId];
      if (player) {
        sql += ' and player like ? collate nocase';
        params.push(`%${player}%`);
      }
      if (staff) {
        sql += ' and staff_id = ?';
        params.push(staff.id);
      }
      const rows = all<Entry>(db, `${sql} order by num desc limit 15`, ...params);
      if (!rows.length) return respond(i, { embeds: [embed().setDescription('No entries found.')] });
      const lines = rows.map((r) => `\`#${r.num}\` **${truncate(r.player, 40)}** · ${truncate(r.items.replace(/\n/g, ', '), 80)}\n> by <@${r.staff_id}>, ok’d by <@${r.authorized_by}> · ${ts(r.created_at, 'R')}`);
      const title = player ? `Items given to “${player}”` : staff ? `Items given by ${staff.username}` : 'Recent item logs';
      return respond(i, { embeds: [embed(colors.cyan).setTitle(title).setDescription(truncate(lines.join('\n'), 4000))] });
    },
  },
};
