import {
  ActionRowBuilder,
  ChannelType,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type GuildMember,
  type PartialGuildMember,
} from 'discord.js';
import { getSettings, setSettings } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, fill, memberVars, ok, respond, truncate } from '../util.js';

export const welcomeDefaults = {
  // empty channel = off
  channel: '',
  message: 'Welcome to **{server}**, {user}! You’re member #{count}.',
  embed: true,
  dmEnabled: false,
  dmMessage: 'Hey {user.name}, welcome to **{server}**! Glad you’re here.',
  leaveChannel: '',
  leaveMessage: '**{user.name}** left the server. We’re now {count} members.',
};
export type WelcomeSettings = typeof welcomeDefaults;
type Which = 'welcome' | 'leave' | 'dm';

const VARS = '`{user}` mention · `{user.name}` username · `{user.id}` id · `{server}` server name · `{count}` member count · `\\n` new line';

export const unescapeTemplate = (s: string) => s.replace(/\\n/g, '\n').trim();

const whichOpt = (choices: Which[]) => (o: import('discord.js').SlashCommandStringOption) =>
  o
    .setName('which')
    .setDescription('Which message')
    .setRequired(true)
    .addChoices(...choices.map((c) => ({ name: c === 'dm' ? 'DM on join' : c === 'welcome' ? 'Welcome' : 'Leave', value: c })));

const command = new SlashCommandBuilder()
  .setName('welcome')
  .setDescription('Welcome and leave messages')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    s
      .setName('channel')
      .setDescription('Choose where welcome or leave messages go')
      .addStringOption(whichOpt(['welcome', 'leave']))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  )
  .addSubcommand((s) => s.setName('message').setDescription('Edit a message template (opens a form)').addStringOption(whichOpt(['welcome', 'leave', 'dm'])))
  .addSubcommand((s) =>
    s
      .setName('style')
      .setDescription('Send welcomes as an embed or plain text')
      .addStringOption((o) =>
        o.setName('style').setDescription('Style').setRequired(true).addChoices({ name: 'Embed with avatar', value: 'embed' }, { name: 'Plain text', value: 'text' }),
      ),
  )
  .addSubcommand((s) => s.setName('off').setDescription('Turn off welcome, leave or DM messages').addStringOption(whichOpt(['welcome', 'leave', 'dm'])))
  .addSubcommand((s) => s.setName('test').setDescription('Send the welcome as if you just joined'))
  .addSubcommand((s) => s.setName('show').setDescription('Show the current setup'));

type AnyMember = GuildMember | PartialGuildMember;

function build(cfg: WelcomeSettings, member: AnyMember, template: string) {
  const text = truncate(fill(template, memberVars(member as GuildMember)), 2000);
  if (!cfg.embed) return { content: text };
  return { embeds: [embed(colors.primary).setDescription(text).setThumbnail(member.user.displayAvatarURL({ size: 256 }))] };
}

async function post(guild: Guild, channelId: string, payload: object): Promise<string | null> {
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) return 'That channel doesn’t exist any more. Pick a new one with `/welcome channel`.';
  const me = guild.members.me;
  const perms = me ? ch.permissionsFor(me) : null;
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
    return `I need View Channel, Send Messages and Embed Links in <#${ch.id}>.`;
  await ch.send({ ...payload, allowedMentions: { parse: ['users'] } });
  return null;
}

export async function sendWelcome(ctx: Ctx, member: GuildMember) {
  const cfg = getSettings(ctx.db, member.guild.id, 'welcome', welcomeDefaults);
  if (cfg.channel) {
    const err = await post(member.guild, cfg.channel, build(cfg, member, cfg.message));
    if (err) console.warn(`[welcome] ${member.guild.id}: ${err}`);
  }
  if (cfg.dmEnabled && cfg.dmMessage && !member.user.bot) {
    await member.send({ content: truncate(fill(cfg.dmMessage, memberVars(member)), 2000) }).catch(() => {});
  }
}

export const welcomeModule: Module = {
  id: 'welcome',
  name: 'Welcome',
  description: 'Welcome and leave messages, as an embed or plain text, plus an optional DM to new members.',
  defaultOn: true,
  commands: [command.toJSON()],
  handle: {
    async welcome(i, { db }) {
      const sub = i.options.getSubcommand();
      const cfg = getSettings(db, i.guildId, 'welcome', welcomeDefaults);

      if (sub === 'channel') {
        const which = i.options.getString('which', true) as Which;
        const ch = i.options.getChannel('channel', true);
        const me = i.guild.members.me;
        const perms = me && 'permissionsFor' in ch ? ch.permissionsFor(me) : null;
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
          return fail(i, `I need View Channel, Send Messages and Embed Links in <#${ch.id}> first.`);
        setSettings(db, i.guildId, 'welcome', welcomeDefaults, which === 'welcome' ? { channel: ch.id } : { leaveChannel: ch.id });
        return ok(i, `${which === 'welcome' ? 'Welcome' : 'Leave'} messages now go to <#${ch.id}>.`);
      }

      if (sub === 'message') {
        const which = i.options.getString('which', true) as Which;
        const current = which === 'welcome' ? cfg.message : which === 'leave' ? cfg.leaveMessage : cfg.dmMessage;
        const input = new TextInputBuilder()
          .setCustomId('template')
          .setLabel(which === 'dm' ? 'DM message' : which === 'welcome' ? 'Welcome message' : 'Leave message')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('{user} {user.name} {user.id} {server} {count}')
          .setMaxLength(1800)
          .setRequired(true)
          .setValue(current.slice(0, 1800));
        const modal = new ModalBuilder()
          .setCustomId(`wl:msg:${which}`)
          .setTitle(which === 'dm' ? 'DM on join' : which === 'welcome' ? 'Welcome message' : 'Leave message')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        return i.showModal(modal);
      }

      if (sub === 'style') {
        const style = i.options.getString('style', true);
        setSettings(db, i.guildId, 'welcome', welcomeDefaults, { embed: style === 'embed' });
        return ok(i, style === 'embed' ? 'Welcomes will be sent as an embed with the member’s avatar.' : 'Welcomes will be sent as plain text.');
      }

      if (sub === 'off') {
        const which = i.options.getString('which', true) as Which;
        setSettings(db, i.guildId, 'welcome', welcomeDefaults, which === 'welcome' ? { channel: '' } : which === 'leave' ? { leaveChannel: '' } : { dmEnabled: false });
        return ok(i, `Turned off ${which === 'dm' ? 'the join DM' : `${which} messages`}.`);
      }

      if (sub === 'test') {
        if (!cfg.channel) return fail(i, 'There’s no welcome channel yet. Set one with `/welcome channel`.');
        const err = await post(i.guild, cfg.channel, build(cfg, i.member, cfg.message));
        if (err) return fail(i, err);
        return ok(i, `Sent a test welcome to <#${cfg.channel}>.`);
      }

      const e = embed()
        .setTitle('Welcome setup')
        .addFields(
          { name: 'Welcome', value: `${cfg.channel ? `<#${cfg.channel}>` : 'Off'} · ${cfg.embed ? 'embed' : 'plain text'}\n${truncate(cfg.message, 1000)}` },
          { name: 'Join DM', value: `${cfg.dmEnabled ? 'On' : 'Off'}\n${truncate(cfg.dmMessage, 1000)}` },
          { name: 'Leave', value: `${cfg.leaveChannel ? `<#${cfg.leaveChannel}>` : 'Off'}\n${truncate(cfg.leaveMessage, 1000)}` },
          { name: 'Variables', value: VARS },
        );
      return respond(i, { embeds: [e] });
    },
  },
  components: {
    async wl(i, args, { db }) {
      if (!i.isModalSubmit() || args[0] !== 'msg' || !i.guildId) return;
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need Manage Server to change this.');
      const which = args[1] as Which;
      const text = unescapeTemplate(i.fields.getTextInputValue('template'));
      if (!text) return fail(i, 'The message can’t be empty.');
      const patch: Partial<WelcomeSettings> = which === 'welcome' ? { message: text } : which === 'leave' ? { leaveMessage: text } : { dmMessage: text, dmEnabled: true };
      const cfg = setSettings(db, i.guildId, 'welcome', welcomeDefaults, patch);
      const missing = which === 'welcome' && !cfg.channel ? ' Set a channel with `/welcome channel` to start sending it.' : which === 'leave' && !cfg.leaveChannel ? ' Set a channel with `/welcome channel` to start sending it.' : '';
      const preview = i.member && 'user' in i.member && i.guild ? fill(text, memberVars(i.member as GuildMember)) : text;
      return respond(i, { embeds: [embed(colors.success).setDescription(`✅ Saved the ${which === 'dm' ? 'join DM (it’s on now)' : `${which} message`}.${missing}\n\n**Preview:**\n${truncate(preview, 3500)}`)] });
    },
  },
  init(ctx) {
    ctx.client.on(Events.GuildMemberAdd, async (member) => {
      try {
        if (!ctx.enabled(member.guild.id, 'welcome')) return;
        await sendWelcome(ctx, member);
      } catch (e) {
        console.warn('[welcome] join:', e instanceof Error ? e.message : e);
      }
    });

    ctx.client.on(Events.GuildMemberRemove, async (member) => {
      try {
        if (!ctx.enabled(member.guild.id, 'welcome')) return;
        const cfg = getSettings(ctx.db, member.guild.id, 'welcome', welcomeDefaults);
        if (!cfg.leaveChannel || !member.user) return;
        const err = await post(member.guild, cfg.leaveChannel, build(cfg, member, cfg.leaveMessage));
        if (err) console.warn(`[welcome] ${member.guild.id}: ${err}`);
      } catch (e) {
        console.warn('[welcome] leave:', e instanceof Error ? e.message : e);
      }
    });
  },
};
