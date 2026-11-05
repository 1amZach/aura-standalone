import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { about } from '../about.js';
import type { Module } from '../types.js';
import { colors, embed, fail, ok, respond } from '../util.js';
import { setModuleEnabled } from './state.js';

// set from modules/index.ts, avoids a circular import
let registry: Module[] = [];
export const setRegistry = (m: Module[]) => (registry = m);

const toggleable = () => registry.filter((m) => !m.required);

const NEEDED: [bigint, string][] = [
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  [PermissionFlagsBits.ViewAuditLog, 'View Audit Log'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];

const links = () =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Support server').setURL(about.supportUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('GitHub').setURL(about.repoUrl),
  );

const footer = { text: `Aura v${about.version} · built by ${about.author} · support at discord.gg/agn` };

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check Aura is awake'),
  new SlashCommandBuilder().setName('support').setDescription('Get help with Aura'),
  new SlashCommandBuilder().setName('about').setDescription('About this bot'),
  new SlashCommandBuilder().setName('help').setDescription('What Aura can do and how to set it up'),
  new SlashCommandBuilder()
    .setName('module')
    .setDescription('Turn Aura’s features on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('list').setDescription('Show every module and whether it’s on'))
    .addSubcommand((s) => s.setName('enable').setDescription('Turn a module on').addStringOption((o) => o.setName('module').setDescription('Which').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn a module off').addStringOption((o) => o.setName('module').setDescription('Which').setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder().setName('setup').setDescription('Check Aura’s permissions and see what’s set up').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

const SETUP_HINTS: Record<string, string> = {
  logging: '`/logs set`',
  moderation: '`/modconfig`',
  automod: '`/automod`',
  security: '`/security`, `/lockdown`',
  verification: '`/verification setup`',
  welcome: '`/welcome`',
  roles: '`/autorole`, `/rolepanel`',
  tickets: '`/tickets setup`',
  levels: '`/levels config`',
  giveaways: '`/giveaway start`',
  polls: '`/poll create`',
  suggestions: '`/suggestion setup`',
};

export const coreModule: Module = {
  id: 'core',
  name: 'Core',
  description: 'Help, setup check and module switches.',
  defaultOn: true,
  required: true,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async ping(i) {
      return respond(i, { embeds: [embed(colors.cyan).setDescription(`🏓 Pong! Gateway ping **${i.client.ws.ping} ms**.`)] });
    },
    async help(i, ctx) {
      const lines = registry
        .filter((m) => !m.required)
        .map((m) => `${ctx.enabled(i.guildId, m.id) ? '🟢' : '⚫'} **${m.name}** · ${m.description}${SETUP_HINTS[m.id] ? `\n  Set up with ${SETUP_HINTS[m.id]}` : ''}`);
      return respond(i, {
        embeds: [
          embed()
            .setTitle('Aura')
            .setDescription(
              `Moderation, security, community and engagement for your server.\n\nAdmins: run \`/setup\` first to check my permissions, then \`/module\` to switch features on or off.\n\n${lines.join('\n')}\n\nStuck? Use \`/support\` or ask in the ${about.supportName} server.`,
            )
            .setFooter(footer),
        ],
        components: [links()],
      });
    },
    async support(i) {
      return respond(i, {
        embeds: [
          embed(colors.cyan)
            .setTitle('Need a hand?')
            .setDescription(
              `Support for Aura happens in the **${about.supportName}** Discord. Head to the support channels there and someone will help you out.\n\nFound a bug or have an idea? Open an issue on GitHub.\n\n${about.supportUrl}`,
            )
            .setFooter(footer),
        ],
        components: [links()],
      });
    },
    async about(i) {
      return respond(i, {
        embeds: [
          embed()
            .setTitle(`Aura v${about.version}`)
            .setDescription(`The free, self-hosted edition of Aura.\n\nBuilt by **${about.author}** for the ${about.supportName} community and anyone else who wants it.`)
            .addFields(
              { name: 'Servers', value: String(i.client.guilds.cache.size), inline: true },
              { name: 'Uptime', value: `<t:${Math.floor((Date.now() - i.client.uptime) / 1000)}:R>`, inline: true },
              { name: 'Support', value: `[discord.gg/agn](${about.supportUrl})`, inline: true },
            )
            .setFooter(footer),
        ],
        components: [links()],
      });
    },
    async module(i, ctx) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const lines = toggleable().map((m) => `${ctx.enabled(i.guildId, m.id) ? '🟢 on ' : '⚫ off'} · **${m.name}** (\`${m.id}\`)`);
        return respond(i, { embeds: [embed().setTitle('Modules').setDescription(lines.join('\n'))] });
      }
      const id = i.options.getString('module', true);
      const m = toggleable().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
      if (!m) return fail(i, `There’s no module called \`${id}\`. See \`/module list\`.`);
      setModuleEnabled(ctx.db, i.guildId, m.id, sub === 'enable');
      return ok(i, `**${m.name}** is now ${sub === 'enable' ? 'on' : 'off'}.${sub === 'enable' && SETUP_HINTS[m.id] ? ` Set it up with ${SETUP_HINTS[m.id]}.` : ''}`);
    },
    async setup(i, ctx) {
      const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
      const missing = NEEDED.filter(([p]) => !me.permissions.has(p)).map(([, n]) => n);
      const highest = i.guild.roles.cache.filter((r) => r.id !== i.guildId).sort((a, b) => b.position - a.position).first();
      const lines = [
        missing.length ? `⚠️ **Missing permissions:** ${missing.join(', ')}` : '✅ I have every permission I need.',
        highest && me.roles.highest.id !== highest.id
          ? `⚠️ My highest role is **${me.roles.highest.name}**. Drag it near the top of the role list so I can manage roles and members below it.`
          : '✅ My role is at the top of the list.',
        '',
        ...toggleable().map((m) => `${ctx.enabled(i.guildId, m.id) ? '🟢' : '⚫'} **${m.name}**${SETUP_HINTS[m.id] ? ` · ${SETUP_HINTS[m.id]}` : ''}`),
      ];
      return respond(i, { embeds: [embed(missing.length ? colors.warning : colors.success).setTitle('Aura setup').setDescription(lines.join('\n'))] });
    },
  },
  autocomplete: {
    async module(i) {
      const q = i.options.getFocused().toLowerCase();
      await i.respond(toggleable().filter((m) => m.id.includes(q) || m.name.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ name: m.name, value: m.id })));
    },
  },
};
