import {
  MessageFlags,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type User,
} from 'discord.js';
import { all, get, getSettings, run, setSettings, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, ok, respond, truncate, ts } from '../util.js';

const schema = `
create table if not exists tickets_tickets (
  id integer primary key autoincrement,
  guild_id text not null,
  num integer not null,
  channel_id text not null,
  opener_id text not null,
  reason text not null default '',
  claimed_by text,
  status text not null default 'open',
  created_at integer not null,
  closed_at integer,
  closed_by text,
  close_reason text,
  unique (guild_id, num)
);
create index if not exists tickets_open_by_user on tickets_tickets (guild_id, opener_id) where status = 'open';
create index if not exists tickets_by_channel on tickets_tickets (channel_id);
`;

export const ticketDefaults = {
  categoryId: '',
  staffRoleId: '',
  logChannelId: '',
  panelChannelId: '',
  panelMessageId: '',
  panelTitle: 'Need help?',
  panelMessage: 'Click the button below to open a private ticket with the staff team.',
  maxOpen: 1,
  askReason: false,
};
type TicketSettings = typeof ticketDefaults;

interface TicketRow {
  id: number;
  guild_id: string;
  num: number;
  channel_id: string;
  opener_id: string;
  reason: string;
  claimed_by: string | null;
  status: 'open' | 'closed';
  created_at: number;
  closed_at: number | null;
  closed_by: string | null;
  close_reason: string | null;
}

export const TRANSCRIPT_LIMIT = 1000;

export function ticketChannelName(num: number, username: string): string {
  const clean = username.toLowerCase().replace(/[^a-z0-9_-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `ticket-${num}${clean ? `-${clean}` : ''}`;
}

export function cleanChannelName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9_-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
}

export interface TranscriptMessage {
  author: string;
  authorId: string;
  createdAt: number;
  content: string;
  attachments: string[];
  embeds?: number;
}

const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

export function formatTranscript(header: string[], messages: TranscriptMessage[]): string {
  const lines = [...header, `Messages: ${messages.length}`, ''.padEnd(60, '-'), ''];
  for (const m of messages) {
    lines.push(`[${stamp(m.createdAt)}] ${m.author} (${m.authorId})`);
    if (m.content) lines.push(...m.content.split('\n').map((l) => `  ${l}`));
    for (const a of m.attachments) lines.push(`  [attachment] ${a}`);
    if (m.embeds) lines.push(`  [${m.embeds} embed${m.embeds === 1 ? '' : 's'}]`);
    lines.push('');
  }
  return lines.join('\n');
}

async function fetchHistory(channel: TextChannel, limit = TRANSCRIPT_LIMIT): Promise<Message[]> {
  const out: Message[] = [];
  let before: string | undefined;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), before });
    if (!batch.size) break;
    out.push(...batch.values());
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return out.reverse();
}

const cfgOf = (db: DB, guildId: string) => getSettings(db, guildId, 'tickets', ticketDefaults);
const ticketIn = (db: DB, channelId: string) => get<TicketRow>(db, "select * from tickets_tickets where channel_id = ? and status = 'open'", channelId);
const isStaff = (m: GuildMember, cfg: TicketSettings) => (cfg.staffRoleId && m.roles.cache.has(cfg.staffRoleId)) || m.permissions.has(PermissionFlagsBits.ManageChannels);

const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];
const BOT_NEEDS = [...MEMBER_ALLOW, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];

const pendingReasons = new Map<string, string>();
const closing = new Set<number>();

async function ticketLog(ctx: Ctx, guild: Guild, e: EmbedBuilder, files: AttachmentBuilder[] = []) {
  const cfg = cfgOf(ctx.db, guild.id);
  if (cfg.logChannelId) {
    try {
      const ch = guild.channels.cache.get(cfg.logChannelId) ?? (await guild.channels.fetch(cfg.logChannelId).catch(() => null));
      if (ch?.isTextBased()) await ch.send({ embeds: [e.setTimestamp()], files, allowedMentions: { parse: [] } });
    } catch (err) {
      console.warn('[tickets] log channel:', err instanceof Error ? err.message : err);
    }
  }
  await ctx.log(guild, 'server', e);
}

const controls = (claimedBy?: string | null, claimedName?: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('tk:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('tk:claim')
      .setLabel(claimedBy ? truncate(`Claimed by ${claimedName ?? 'staff'}`, 80) : 'Claim')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!claimedBy),
  );

const confirmRow = (ticketId: number) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tk:confirm:${ticketId}`).setLabel('Close ticket').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('tk:cancel').setLabel('Keep it open').setStyle(ButtonStyle.Secondary),
  );

async function openTicket(ctx: Ctx, guild: Guild, user: User, reason: string): Promise<{ ok: boolean; text: string }> {
  const { db } = ctx;
  const cfg = cfgOf(db, guild.id);
  if (!cfg.categoryId || !cfg.staffRoleId) return { ok: false, text: 'Tickets aren’t set up yet. An admin can run `/tickets setup`.' };
  const category = guild.channels.cache.get(cfg.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) return { ok: false, text: 'The ticket category is gone. An admin needs to run `/tickets setup` again.' };
  const me = guild.members.me;
  if (!me?.permissions.has(BOT_NEEDS)) return { ok: false, text: 'I’m missing permissions to make tickets (Manage Channels and Manage Roles). Let a staff member know.' };

  // channels deleted while the bot was offline
  const mine = all<TicketRow>(db, "select * from tickets_tickets where guild_id = ? and opener_id = ? and status = 'open' order by id", guild.id, user.id);
  const live = mine.filter((t) => {
    if (guild.channels.cache.has(t.channel_id)) return true;
    run(db, "update tickets_tickets set status = 'closed', closed_at = ?, close_reason = 'Channel deleted' where id = ?", Date.now(), t.id);
    return false;
  });
  if (live.length >= Math.max(1, cfg.maxOpen))
    return { ok: false, text: `You already have an open ticket: <#${live[0].channel_id}>${live.length > 1 ? ` (and ${live.length - 1} more)` : ''}.` };

  const num = get<{ n: number }>(db, 'select coalesce(max(num), 0) + 1 as n from tickets_tickets where guild_id = ?', guild.id)?.n ?? 1;
  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: ticketChannelName(num, user.username),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `Ticket #${num} opened by ${user.username} (${user.id})`,
      reason: `Ticket #${num} opened by ${user.username}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: MEMBER_ALLOW },
        { id: cfg.staffRoleId, allow: MEMBER_ALLOW },
        { id: me.id, allow: [...MEMBER_ALLOW, PermissionFlagsBits.ManageChannels] },
      ],
    });
  } catch (e) {
    console.warn('[tickets] create channel:', e instanceof Error ? e.message : e);
    return { ok: false, text: 'I couldn’t create the ticket channel. Check I have Manage Channels in the ticket category, and that it isn’t full (50 channels max).' };
  }
  run(
    db,
    'insert into tickets_tickets (guild_id, num, channel_id, opener_id, reason, created_at) values (?, ?, ?, ?, ?, ?)',
    guild.id, num, channel.id, user.id, reason, Date.now(),
  );

  const welcome = embed(colors.primary)
    .setTitle(`Ticket #${num}`)
    .setDescription(`Thanks for reaching out, <@${user.id}>. Staff will be with you soon. Tell us what you need in the meantime.`)
    .setFooter({ text: 'Use the buttons below, or /ticket, to manage this ticket.' });
  if (reason) welcome.addFields({ name: 'Reason', value: truncate(reason, 1024) });
  await channel
    .send({ content: `<@${user.id}> <@&${cfg.staffRoleId}>`, embeds: [welcome], components: [controls()], allowedMentions: { users: [user.id], roles: [cfg.staffRoleId] } })
    .catch((e) => console.warn('[tickets] welcome message:', e instanceof Error ? e.message : e));

  await ticketLog(
    ctx,
    guild,
    embed(colors.success)
      .setTitle(`🎫 Ticket #${num} opened`)
      .addFields({ name: 'By', value: `<@${user.id}> (${user.username})`, inline: true }, { name: 'Channel', value: `<#${channel.id}>`, inline: true })
      .addFields(reason ? [{ name: 'Reason', value: truncate(reason, 1024) }] : []),
  );
  return { ok: true, text: `Your ticket is open: <#${channel.id}>` };
}

async function claimTicket(ctx: Ctx, guild: Guild, t: TicketRow, by: GuildMember) {
  run(ctx.db, 'update tickets_tickets set claimed_by = ? where id = ?', by.id, t.id);
  await ticketLog(
    ctx,
    guild,
    embed(colors.blue)
      .setTitle(`🙋 Ticket #${t.num} claimed`)
      .addFields({ name: 'By', value: `<@${by.id}>`, inline: true }, { name: 'Channel', value: `<#${t.channel_id}>`, inline: true }),
  );
}

async function closeTicket(ctx: Ctx, guild: Guild, t: TicketRow, by: User, reason: string) {
  if (closing.has(t.id)) return;
  closing.add(t.id);
  try {
    const channel = guild.channels.cache.get(t.channel_id) as TextChannel | undefined;
    run(ctx.db, "update tickets_tickets set status = 'closed', closed_at = ?, closed_by = ?, close_reason = ? where id = ?", Date.now(), by.id, reason, t.id);
    if (channel) {
      await channel
        .send({ embeds: [embed(colors.warning).setDescription(`🔒 Ticket closed by <@${by.id}>${reason ? `: ${truncate(reason, 500)}` : ''}. This channel will be deleted in 5 seconds.`)], allowedMentions: { parse: [] } })
        .catch(() => {});
    }

    let file: AttachmentBuilder | null = null;
    if (channel) {
      try {
        const history = await fetchHistory(channel);
        const opener = await ctx.client.users.fetch(t.opener_id).catch(() => null);
        const text = formatTranscript(
          [
            `Ticket #${t.num} in ${guild.name}`,
            `Opened by: ${opener?.username ?? 'unknown'} (${t.opener_id}) at ${stamp(t.created_at)}`,
            `Reason: ${t.reason || 'none given'}`,
            `Claimed by: ${t.claimed_by ?? 'nobody'}`,
            `Closed by: ${by.username} (${by.id}) at ${stamp(Date.now())}`,
            `Close reason: ${reason || 'none given'}`,
          ],
          history.map((m) => ({
            author: m.author.username,
            authorId: m.author.id,
            createdAt: m.createdTimestamp,
            content: m.content,
            attachments: [...m.attachments.values()].map((a) => a.url),
            embeds: m.embeds.length,
          })),
        );
        file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: `ticket-${t.num}-transcript.txt` });
      } catch (e) {
        console.warn('[tickets] transcript:', e instanceof Error ? e.message : e);
      }
    }

    const e = embed(colors.danger)
      .setTitle(`🔒 Ticket #${t.num} closed`)
      .addFields(
        { name: 'Opened by', value: `<@${t.opener_id}>`, inline: true },
        { name: 'Closed by', value: `<@${by.id}>`, inline: true },
        { name: 'Claimed by', value: t.claimed_by ? `<@${t.claimed_by}>` : 'Nobody', inline: true },
        { name: 'Opened', value: ts(t.created_at, 'f'), inline: true },
        { name: 'Reason', value: truncate(reason || 'No reason given', 1024) },
      );
    await ticketLog(ctx, guild, e, file ? [file] : []);

    const opener = await ctx.client.users.fetch(t.opener_id).catch(() => null);
    if (opener && !opener.bot) {
      await opener
        .send({
          embeds: [embed(colors.muted).setDescription(`Your ticket #${t.num} in **${guild.name}** was closed${reason ? `: ${truncate(reason, 500)}` : '.'}${file ? ' Here’s a copy of the conversation.' : ''}`)],
          files: file ? [file] : [],
        })
        .catch(() => {});
    }

    if (channel) {
      setTimeout(() => {
        channel.delete(`Ticket #${t.num} closed`).catch((err) => console.warn('[tickets] delete channel:', err instanceof Error ? err.message : err));
      }, 5000);
    }
  } finally {
    setTimeout(() => closing.delete(t.id), 10_000);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('tickets')
    .setDescription('Set up support tickets')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Save ticket settings and post the “Open a ticket” panel')
        .addChannelOption((o) => o.setName('category').setDescription('Category new tickets go in').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
        .addRoleOption((o) => o.setName('staff_role').setDescription('Role that can see and handle tickets').setRequired(true))
        .addChannelOption((o) => o.setName('log_channel').setDescription('Where ticket logs and transcripts go').addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) => o.setName('panel_channel').setDescription('Where to post the panel (default here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('panel_title').setDescription('Panel title').setMaxLength(256))
        .addStringOption((o) => o.setName('panel_message').setDescription('Panel text').setMaxLength(2000))
        .addIntegerOption((o) => o.setName('max_open').setDescription('Open tickets allowed per person (default 1)').setMinValue(1).setMaxValue(10))
        .addBooleanOption((o) => o.setName('ask_reason').setDescription('Ask for a short reason before opening')),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show the ticket settings')),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Manage the ticket you’re in')
    .addSubcommand((s) => s.setName('close').setDescription('Close this ticket').addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500)))
    .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('rename').setDescription('Rename this ticket channel').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)))
    .addSubcommand((s) => s.setName('claim').setDescription('Claim this ticket so others know you’re on it')),
];

export const ticketsModule: Module = {
  id: 'tickets',
  name: 'Tickets',
  description: 'Private support tickets from a button panel, with claim, add/remove, and text transcripts on close.',
  defaultOn: false,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async tickets(i, { db }) {
      const sub = i.options.getSubcommand();
      if (sub === 'show') {
        const cfg = cfgOf(db, i.guildId);
        const open = get<{ n: number }>(db, "select count(*) as n from tickets_tickets where guild_id = ? and status = 'open'", i.guildId)?.n ?? 0;
        return respond(i, {
          embeds: [
            embed()
              .setTitle('Ticket settings')
              .setDescription(
                [
                  `**Category:** ${cfg.categoryId ? `<#${cfg.categoryId}>` : 'not set'}`,
                  `**Staff role:** ${cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : 'not set'}`,
                  `**Log channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'none'}`,
                  `**Panel:** ${cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : 'not posted'}`,
                  `**Open per person:** ${cfg.maxOpen}`,
                  `**Ask for a reason:** ${cfg.askReason ? 'Yes' : 'No'}`,
                  `**Open right now:** ${open}`,
                ].join('\n'),
              ),
          ],
        });
      }

      const category = i.options.getChannel('category', true);
      const staff = i.options.getRole('staff_role', true);
      const log = i.options.getChannel('log_channel');
      const panelCh = i.options.getChannel('panel_channel') ?? i.channel;
      const me = i.guild.members.me;
      if (!me?.permissions.has(BOT_NEEDS)) return fail(i, 'I need Manage Channels, Manage Roles, View Channel, Send Messages, Read Message History, Attach Files and Embed Links to run tickets.');
      if (staff.id === i.guildId) return fail(i, 'Pick a staff role other than @everyone.');
      if (!panelCh || !('send' in panelCh) || !panelCh.isTextBased()) return fail(i, 'I can’t post the panel in that channel.');
      if (!panelCh.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
        return fail(i, `I need View Channel, Send Messages and Embed Links in <#${panelCh.id}>.`);
      if (log && 'permissionsFor' in log && !log.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]))
        return fail(i, `I need View Channel, Send Messages and Attach Files in <#${log.id}> for logs and transcripts.`);

      const prev = cfgOf(db, i.guildId);
      const cfg = setSettings(db, i.guildId, 'tickets', ticketDefaults, {
        categoryId: category.id,
        staffRoleId: staff.id,
        logChannelId: log?.id ?? '',
        panelTitle: i.options.getString('panel_title') ?? prev.panelTitle,
        panelMessage: i.options.getString('panel_message') ?? prev.panelMessage,
        maxOpen: i.options.getInteger('max_open') ?? prev.maxOpen,
        askReason: i.options.getBoolean('ask_reason') ?? prev.askReason,
      });

      const payload = {
        embeds: [embed(colors.primary).setTitle(cfg.panelTitle).setDescription(cfg.panelMessage)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('tk:open').setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary))],
      };
      try {
        let messageId = '';
        if (prev.panelMessageId && prev.panelChannelId === panelCh.id) {
          const existing = await panelCh.messages.fetch(prev.panelMessageId).catch(() => null);
          if (existing) messageId = (await existing.edit(payload)).id;
        }
        if (!messageId) messageId = (await panelCh.send(payload)).id;
        setSettings(db, i.guildId, 'tickets', ticketDefaults, { panelChannelId: panelCh.id, panelMessageId: messageId });
      } catch (e) {
        console.warn('[tickets] panel:', e instanceof Error ? e.message : e);
        return fail(i, `Settings saved, but I couldn’t post the panel in <#${panelCh.id}>.`);
      }
      return ok(
        i,
        `Tickets are set up. New tickets go in **${category.name}** and <@&${staff.id}> can see them. The panel is in <#${panelCh.id}>.\nMake sure the Tickets module is on: \`/module enable tickets\`.`,
      );
    },

    async ticket(i, ctx) {
      const { db } = ctx;
      const t = ticketIn(db, i.channelId);
      if (!t) return fail(i, 'This isn’t an open ticket. Use `/ticket` inside a ticket channel.');
      const cfg = cfgOf(db, i.guildId);
      const staff = isStaff(i.member, cfg);
      const sub = i.options.getSubcommand();
      const channel = i.channel as TextChannel | null;
      if (!channel) return fail(i, 'I can’t see this channel.');

      if (sub === 'close') {
        if (!staff && i.user.id !== t.opener_id) return fail(i, 'Only staff or the person who opened this ticket can close it.');
        pendingReasons.set(`${t.id}:${i.user.id}`, i.options.getString('reason') ?? '');
        return respond(i, { embeds: [embed(colors.warning).setDescription('Close this ticket? A transcript will be saved and the channel deleted.')], components: [confirmRow(t.id)] });
      }
      if (!staff) return fail(i, 'Only staff can do that.');

      if (sub === 'claim') {
        if (t.claimed_by) return fail(i, `<@${t.claimed_by}> already claimed this ticket.`);
        await claimTicket(ctx, i.guild, t, i.member);
        return respond(i, { embeds: [embed(colors.blue).setDescription(`🙋 <@${i.user.id}> claimed this ticket.`)] }, false);
      }

      if (sub === 'add' || sub === 'remove') {
        const user = i.options.getUser('user', true);
        if (user.bot && user.id === ctx.client.user.id) return fail(i, 'I’m already here.');
        try {
          if (sub === 'add') {
            await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
            return respond(i, { embeds: [embed(colors.success).setDescription(`Added <@${user.id}> to this ticket.`)] }, false);
          }
          if (user.id === t.opener_id) return fail(i, 'That’s the person who opened the ticket. Close it instead.');
          await channel.permissionOverwrites.delete(user.id);
          return respond(i, { embeds: [embed(colors.muted).setDescription(`Removed <@${user.id}> from this ticket.`)] }, false);
        } catch (e) {
          console.warn('[tickets] add/remove:', e instanceof Error ? e.message : e);
          return fail(i, 'I couldn’t change who can see this channel. I need Manage Roles (Manage Permissions) here.');
        }
      }

      const name = cleanChannelName(i.options.getString('name', true));
      if (!name) return fail(i, 'Use letters, numbers, dashes or underscores.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      // discord.js silently waits out the 2-per-10-min rename limit, so don't hang forever
      const renamed = await Promise.race([
        channel.setName(name, `Renamed by ${i.user.username}`).then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 8000)),
      ]).catch(() => null);
      if (renamed === null) return fail(i, 'I couldn’t rename this channel.');
      if (!renamed) return ok(i, 'Discord limits renames to two every 10 minutes, so the new name will show up shortly.');
      return ok(i, `Renamed to **${name}**.`);
    },
  },
  components: {
    async tk(i, args, ctx) {
      if (!i.inCachedGuild()) return;
      const { db } = ctx;
      const [action] = args;

      if (action === 'open' && i.isButton()) {
        const cfg = cfgOf(db, i.guildId);
        if (cfg.askReason) {
          const modal = new ModalBuilder()
            .setCustomId('tk:reason')
            .setTitle('Open a ticket')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true),
              ),
            );
          return i.showModal(modal);
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await openTicket(ctx, i.guild, i.user, '');
        return r.ok ? ok(i, r.text) : fail(i, r.text);
      }

      if (action === 'reason' && i.isModalSubmit()) {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await openTicket(ctx, i.guild, i.user, i.fields.getTextInputValue('reason').trim());
        return r.ok ? ok(i, r.text) : fail(i, r.text);
      }

      if (action === 'cancel' && i.isButton()) {
        return i.update({ embeds: [embed(colors.muted).setDescription('Okay, the ticket stays open.')], components: [] });
      }

      const t = ticketIn(db, i.channelId ?? '');
      if (!t) return fail(i, 'This ticket is already closed.');
      const cfg = cfgOf(db, i.guildId);
      const staff = isStaff(i.member, cfg);

      if (action === 'close' && i.isButton()) {
        if (!staff && i.user.id !== t.opener_id) return fail(i, 'Only staff or the person who opened this ticket can close it.');
        pendingReasons.delete(`${t.id}:${i.user.id}`);
        return respond(i, { embeds: [embed(colors.warning).setDescription('Close this ticket? A transcript will be saved and the channel deleted.')], components: [confirmRow(t.id)] });
      }

      if (action === 'confirm' && i.isButton()) {
        if (Number(args[1]) !== t.id) return fail(i, 'This ticket is already closed.');
        if (!staff && i.user.id !== t.opener_id) return fail(i, 'Only staff or the person who opened this ticket can close it.');
        const key = `${t.id}:${i.user.id}`;
        const reason = pendingReasons.get(key) ?? '';
        pendingReasons.delete(key);
        await i.update({ embeds: [embed(colors.warning).setDescription('Closing the ticket…')], components: [] });
        return closeTicket(ctx, i.guild, t, i.user, reason);
      }

      if (action === 'claim' && i.isButton()) {
        if (!staff) return fail(i, 'Only staff can claim tickets.');
        if (t.claimed_by) return fail(i, `<@${t.claimed_by}> already claimed this ticket.`);
        await claimTicket(ctx, i.guild, t, i.member);
        await i.message.edit({ components: [controls(i.user.id, i.member.displayName)] }).catch(() => {});
        return respond(i, { embeds: [embed(colors.blue).setDescription(`🙋 <@${i.user.id}> claimed this ticket.`)] }, false);
      }
    },
  },
  init(ctx) {
    ctx.client.on(Events.ChannelDelete, async (channel) => {
      try {
        if (channel.isDMBased() || !ctx.enabled(channel.guild.id, 'tickets')) return;
        const t = ticketIn(ctx.db, channel.id);
        if (!t || closing.has(t.id)) return;
        run(ctx.db, "update tickets_tickets set status = 'closed', closed_at = ?, close_reason = 'Channel deleted' where id = ?", Date.now(), t.id);
        await ticketLog(
          ctx,
          channel.guild,
          embed(colors.danger)
            .setTitle(`🗑️ Ticket #${t.num} closed`)
            .setDescription('The channel was deleted by hand, so there’s no transcript.')
            .addFields({ name: 'Opened by', value: `<@${t.opener_id}>`, inline: true }),
        );
      } catch (e) {
        console.warn('[tickets] channel delete:', e instanceof Error ? e.message : e);
      }
    });
  },
};
