import { AuditLogEvent, ChannelType, Events, SlashCommandBuilder, PermissionFlagsBits, type Message, type PartialMessage } from 'discord.js';
import { getSettings, setSettings } from '../db.js';
import type { LogKind, Module } from '../types.js';
import { colors, embed, ok, respond, truncate } from '../util.js';

export const logDefaults = {
  channels: {} as Partial<Record<LogKind | 'fallback', string>>,
  ignored: [] as string[],
};

const KINDS: { value: LogKind | 'fallback'; label: string }[] = [
  { value: 'fallback', label: 'Everything (default for any type without its own channel)' },
  { value: 'mod', label: 'Moderation (bans, kicks, warnings, timeouts)' },
  { value: 'messages', label: 'Messages (edits, deletes)' },
  { value: 'members', label: 'Members (joins, leaves, nickname and role changes)' },
  { value: 'security', label: 'Security (raids, nukes, scams, automod)' },
  { value: 'server', label: 'Server (channels and roles)' },
];

const command = new SlashCommandBuilder()
  .setName('logs')
  .setDescription('Choose where Aura posts its logs')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Send one type of log to a channel')
      .addStringOption((o) => o.setName('type').setDescription('Which logs').setRequired(true).addChoices(...KINDS.map((k) => ({ name: k.label, value: k.value }))))
      .addChannelOption((o) => o.setName('channel').setDescription('Where they go').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('off')
      .setDescription('Stop one type of log')
      .addStringOption((o) => o.setName('type').setDescription('Which logs').setRequired(true).addChoices(...KINDS.map((k) => ({ name: k.label, value: k.value })))),
  )
  .addSubcommand((s) =>
    s
      .setName('ignore')
      .setDescription('Don’t log message edits and deletes in a channel (toggle)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
  )
  .addSubcommand((s) => s.setName('show').setDescription('Show where logs go'));

const skipMessage = (m: Message | PartialMessage, ignored: string[]) => !m.guild || m.author?.bot || ignored.includes(m.channelId);

export const loggingModule: Module = {
  id: 'logging',
  name: 'Logging',
  description: 'Logs moderation, message edits and deletes, member changes, and server changes to channels you pick.',
  defaultOn: true,
  commands: [command.toJSON()],
  handle: {
    async logs(i, { db }) {
      const sub = i.options.getSubcommand();
      const cfg = getSettings(db, i.guildId, 'logging', logDefaults);
      if (sub === 'set') {
        const type = i.options.getString('type', true) as LogKind | 'fallback';
        const ch = i.options.getChannel('channel', true);
        setSettings(db, i.guildId, 'logging', logDefaults, { channels: { ...cfg.channels, [type]: ch.id }, ignored: [...new Set([...cfg.ignored, ch.id])] });
        return ok(i, `${KINDS.find((k) => k.value === type)!.label.split(' (')[0]} logs now go to <#${ch.id}>.`);
      }
      if (sub === 'off') {
        const type = i.options.getString('type', true) as LogKind | 'fallback';
        const channels = { ...cfg.channels };
        delete channels[type];
        setSettings(db, i.guildId, 'logging', logDefaults, { channels });
        return ok(i, `Turned off ${KINDS.find((k) => k.value === type)!.label.split(' (')[0].toLowerCase()} logs.`);
      }
      if (sub === 'ignore') {
        const ch = i.options.getChannel('channel', true);
        const on = cfg.ignored.includes(ch.id);
        setSettings(db, i.guildId, 'logging', logDefaults, { ignored: on ? cfg.ignored.filter((x) => x !== ch.id) : [...cfg.ignored, ch.id] });
        return ok(i, on ? `Message edits and deletes in <#${ch.id}> are logged again.` : `Message edits and deletes in <#${ch.id}> won’t be logged.`);
      }
      const lines = KINDS.map((k) => `**${k.label.split(' (')[0]}:** ${cfg.channels[k.value] ? `<#${cfg.channels[k.value]}>` : k.value === 'fallback' ? 'not set' : 'uses Everything'}`);
      if (cfg.ignored.length) lines.push(`**Not logging messages in:** ${cfg.ignored.map((c) => `<#${c}>`).join(', ')}`);
      return respond(i, { embeds: [embed().setTitle('Log channels').setDescription(lines.join('\n'))] });
    },
  },
  init(ctx) {
    const { client, db } = ctx;
    const on = (g: string) => ctx.enabled(g, 'logging');

    client.on(Events.MessageDelete, async (m) => {
      if (!m.guild || !on(m.guild.id)) return;
      const cfg = getSettings(db, m.guild.id, 'logging', logDefaults);
      if (skipMessage(m, cfg.ignored) || (!m.content && !m.attachments?.size)) return;
      const e = embed(colors.danger)
        .setAuthor({ name: m.author?.tag ?? 'Unknown user', iconURL: m.author?.displayAvatarURL() })
        .setTitle('Message deleted')
        .setDescription(truncate(m.content || '*no text*', 3900))
        .addFields({ name: 'Channel', value: `<#${m.channelId}>`, inline: true }, { name: 'Author', value: m.author ? `<@${m.author.id}>` : 'unknown', inline: true });
      if (m.attachments?.size) e.addFields({ name: 'Attachments', value: truncate([...m.attachments.values()].map((a) => a.name).join(', '), 1000) });
      await ctx.log(m.guild, 'messages', e);
    });

    client.on(Events.MessageBulkDelete, async (msgs, channel) => {
      if (!on(channel.guild.id)) return;
      const cfg = getSettings(db, channel.guild.id, 'logging', logDefaults);
      if (cfg.ignored.includes(channel.id)) return;
      await ctx.log(channel.guild, 'messages', embed(colors.danger).setTitle('Messages bulk deleted').setDescription(`**${msgs.size}** messages in <#${channel.id}>`));
    });

    client.on(Events.MessageUpdate, async (before, after) => {
      if (!after.guild || !on(after.guild.id)) return;
      const cfg = getSettings(db, after.guild.id, 'logging', logDefaults);
      if (skipMessage(after, cfg.ignored) || before.partial || before.content === after.content) return;
      await ctx.log(
        after.guild,
        'messages',
        embed(colors.warning)
          .setAuthor({ name: after.author?.tag ?? 'Unknown user', iconURL: after.author?.displayAvatarURL() })
          .setTitle('Message edited')
          .setURL(after.url)
          .addFields(
            { name: 'Before', value: truncate(before.content || '*empty*', 1024) },
            { name: 'After', value: truncate(after.content || '*empty*', 1024) },
            { name: 'Channel', value: `<#${after.channelId}>`, inline: true },
          ),
      );
    });

    client.on(Events.GuildMemberAdd, async (m) => {
      if (!on(m.guild.id)) return;
      const age = Date.now() - m.user.createdTimestamp;
      await ctx.log(
        m.guild,
        'members',
        embed(colors.success)
          .setAuthor({ name: m.user.tag, iconURL: m.user.displayAvatarURL() })
          .setTitle('Member joined')
          .setDescription(`<@${m.id}> · member #${m.guild.memberCount}`)
          .addFields({ name: 'Account created', value: `<t:${Math.floor(m.user.createdTimestamp / 1000)}:R>${age < 7 * 86400e3 ? ' ⚠️ new account' : ''}` }),
      );
    });

    client.on(Events.GuildMemberRemove, async (m) => {
      if (!on(m.guild.id)) return;
      const roles = m.roles?.cache.filter((r) => r.id !== m.guild.id).map((r) => `<@&${r.id}>`) ?? [];
      await ctx.log(
        m.guild,
        'members',
        embed(colors.muted)
          .setAuthor({ name: m.user?.tag ?? m.id, iconURL: m.user?.displayAvatarURL() })
          .setTitle('Member left')
          .setDescription(`<@${m.id}>${m.joinedTimestamp ? ` · joined <t:${Math.floor(m.joinedTimestamp / 1000)}:R>` : ''}`)
          .addFields({ name: 'Roles', value: truncate(roles.join(' ') || 'none', 1024) }),
      );
    });

    client.on(Events.GuildMemberUpdate, async (before, after) => {
      if (!on(after.guild.id) || before.partial) return;
      if (before.nickname !== after.nickname) {
        await ctx.log(after.guild, 'members', embed(colors.blue).setTitle('Nickname changed').setDescription(`<@${after.id}>\n**${before.nickname ?? before.user.username}** → **${after.nickname ?? after.user.username}**`));
      }
      const added = after.roles.cache.filter((r) => !before.roles.cache.has(r.id));
      const removed = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
      if (added.size || removed.size) {
        const lines = [...added.map((r) => `➕ <@&${r.id}>`), ...removed.map((r) => `➖ <@&${r.id}>`)];
        await ctx.log(after.guild, 'members', embed(colors.blue).setTitle('Roles changed').setDescription(`<@${after.id}>\n${lines.join('\n')}`));
      }
    });

    const serverEvent = (title: string, color: number) => async (thing: { guild: import('discord.js').Guild; name: string; id: string }, extra?: string) => {
      if (!on(thing.guild.id)) return;
      await ctx.log(thing.guild, 'server', embed(color).setTitle(title).setDescription(`**${thing.name}** (\`${thing.id}\`)${extra ? `\n${extra}` : ''}`));
    };
    client.on(Events.ChannelCreate, (c) => serverEvent('Channel created', colors.success)(c));
    client.on(Events.ChannelDelete, (c) => {
      if ('guild' in c && c.guild) void serverEvent('Channel deleted', colors.danger)(c as never);
    });
    client.on(Events.GuildRoleCreate, (r) => serverEvent('Role created', colors.success)(r));
    client.on(Events.GuildRoleDelete, (r) => serverEvent('Role deleted', colors.danger)(r));

    // manual bans/kicks from the Discord UI
    client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
      if (!on(guild.id) || entry.executorId === client.user.id) return;
      const map: Partial<Record<AuditLogEvent, [string, number]>> = {
        [AuditLogEvent.MemberBanAdd]: ['Banned (by hand)', colors.danger],
        [AuditLogEvent.MemberBanRemove]: ['Unbanned (by hand)', colors.success],
        [AuditLogEvent.MemberKick]: ['Kicked (by hand)', colors.warning],
      };
      const hit = map[entry.action];
      if (!hit) return;
      await ctx.log(
        guild,
        'mod',
        embed(hit[1])
          .setTitle(hit[0])
          .addFields(
            { name: 'User', value: entry.targetId ? `<@${entry.targetId}>` : 'unknown', inline: true },
            { name: 'By', value: entry.executorId ? `<@${entry.executorId}>` : 'unknown', inline: true },
            { name: 'Reason', value: truncate(entry.reason ?? 'none given', 1024) },
          ),
      );
    });
  },
};
