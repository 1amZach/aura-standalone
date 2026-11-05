import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  type GuildMember,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getSettings, setSettings } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, ok, respond, ts } from '../util.js';

export const verifyDefaults = {
  channelId: '',
  roleId: '',
  unverifiedRoleId: '',
  minAccountAgeDays: 0,
  message: 'Press **Verify** below to get access to the rest of the server.',
};

// Pending codes live in memory. If the bot restarts, people just press Verify again.
const codes = new Map<string, { code: string; expires: number; tries: number }>();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const command = new SlashCommandBuilder()
  .setName('verification')
  .setDescription('Make new members press a button before they can chat')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Post the verify panel')
      .addChannelOption((o) => o.setName('channel').setDescription('Where the panel goes').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role people get once verified').setRequired(true))
      .addRoleOption((o) => o.setName('unverified_role').setDescription('Role given on join and taken away once verified'))
      .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Refuse accounts younger than this (0 = off)').setMinValue(0).setMaxValue(365))
      .addStringOption((o) => o.setName('message').setDescription('Text on the panel').setMaxLength(1500)),
  )
  .addSubcommand((s) => s.setName('approve').setDescription('Verify someone by hand').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
  .addSubcommand((s) => s.setName('show').setDescription('Show how verification is set up'));

async function grant(ctx: Ctx, member: GuildMember, by: string) {
  const cfg = getSettings(ctx.db, member.guild.id, 'verification', verifyDefaults);
  await member.roles.add(cfg.roleId, by === member.id ? 'Verified' : `Verified by staff`);
  if (cfg.unverifiedRoleId && member.roles.cache.has(cfg.unverifiedRoleId)) await member.roles.remove(cfg.unverifiedRoleId, 'Verified').catch(() => {});
  await ctx.log(
    member.guild,
    'members',
    embed(colors.success)
      .setTitle('Member verified')
      .setDescription(by === member.id ? `<@${member.id}> verified themselves.` : `<@${member.id}> was verified by <@${by}>.`),
  );
}

const roleProblem = (member: GuildMember, roleId: string) => {
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return 'Verification isn’t set up properly (the role is gone). Please ask a staff member.';
  if (!role.editable) return 'I can’t give out the verified role. A staff member needs to move my role above it.';
  return null;
};

export const verificationModule: Module = {
  id: 'verification',
  name: 'Verification',
  description: 'A verify button with a short code check, an optional unverified role and a minimum account age.',
  defaultOn: false,
  commands: [command.toJSON()],
  handle: {
    async verification(i, ctx) {
      const sub = i.options.getSubcommand();
      const cfg = getSettings(ctx.db, i.guildId, 'verification', verifyDefaults);

      if (sub === 'setup') {
        if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return fail(i, 'You need **Manage Server** to set up verification.');
        const ch = i.options.getChannel('channel', true, [ChannelType.GuildText]);
        const role = i.options.getRole('role', true);
        const unverified = i.options.getRole('unverified_role');
        if (role.id === i.guildId || role.managed) return fail(i, 'Pick a normal role for verified members.');
        if (!role.editable || (unverified && !unverified.editable)) return fail(i, 'My role needs to be above the roles you picked so I can hand them out.');
        if (unverified?.id === role.id) return fail(i, 'The verified and unverified roles need to be different.');
        const me = i.guild.members.me!;
        if (!me.permissionsIn(ch).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return fail(i, `I can’t post in <#${ch.id}>.`);

        const next = setSettings(ctx.db, i.guildId, 'verification', verifyDefaults, {
          channelId: ch.id,
          roleId: role.id,
          unverifiedRoleId: unverified?.id ?? '',
          minAccountAgeDays: i.options.getInteger('min_account_age_days') ?? cfg.minAccountAgeDays,
          message: i.options.getString('message') ?? cfg.message,
        });
        await ch.send({
          embeds: [embed().setTitle(`Welcome to ${i.guild.name}`).setDescription(next.message)],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success))],
        });
        return ok(i, `Posted the panel in <#${ch.id}>. Verified members get <@&${role.id}>.${unverified ? ` New members get <@&${unverified.id}> until they verify.` : ''}`);
      }

      if (sub === 'approve') {
        if (!cfg.roleId) return fail(i, 'Set up verification first with `/verification setup`.');
        const member = await i.guild.members.fetch(i.options.getUser('user', true).id).catch(() => null);
        if (!member) return fail(i, 'They’re not in the server.');
        if (member.roles.cache.has(cfg.roleId)) return fail(i, 'They’re already verified.');
        const problem = roleProblem(member, cfg.roleId);
        if (problem) return fail(i, problem);
        await grant(ctx, member, i.user.id);
        return ok(i, `Verified <@${member.id}>.`);
      }

      return respond(i, {
        embeds: [
          embed()
            .setTitle('Verification')
            .setDescription(
              cfg.roleId
                ? [
                    `**Panel:** <#${cfg.channelId}>`,
                    `**Verified role:** <@&${cfg.roleId}>`,
                    `**Unverified role:** ${cfg.unverifiedRoleId ? `<@&${cfg.unverifiedRoleId}>` : 'none'}`,
                    `**Minimum account age:** ${cfg.minAccountAgeDays ? `${cfg.minAccountAgeDays} day(s)` : 'none'}`,
                  ].join('\n')
                : 'Not set up yet. Use `/verification setup`.',
            ),
        ],
      });
    },
  },

  components: {
    async verify(i, args, ctx) {
      const guild = i.guild!;
      const member = i.member as GuildMember;
      const cfg = getSettings(ctx.db, guild.id, 'verification', verifyDefaults);
      const key = `${guild.id}:${i.user.id}`;
      if (!cfg.roleId) return fail(i, 'Verification isn’t set up here yet.');
      if (member.roles.cache.has(cfg.roleId)) return fail(i, 'You’re already verified.');

      if (args[0] === 'start') {
        const minAge = cfg.minAccountAgeDays * 86400e3;
        if (minAge && Date.now() - i.user.createdTimestamp < minAge) {
          return fail(i, `Your account is too new to verify here. Accounts need to be at least ${cfg.minAccountAgeDays} day(s) old, so you can try again ${ts(i.user.createdTimestamp + minAge, 'R')}.`);
        }
        const problem = roleProblem(member, cfg.roleId);
        if (problem) return fail(i, problem);
        const code = makeCode();
        codes.set(key, { code, expires: Date.now() + 10 * 60e3, tries: 0 });
        if (codes.size > 5000) codes.delete(codes.keys().next().value!);
        return respond(i, {
          embeds: [embed().setDescription(`Your code is **\`${code}\`**\nPress **Enter code** and type it in. It works for 10 minutes.`)],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('verify:code').setLabel('Enter code').setStyle(ButtonStyle.Primary))],
        });
      }

      const pending = codes.get(key);
      if (!pending || pending.expires < Date.now()) {
        codes.delete(key);
        return fail(i, 'Your code ran out. Press **Verify** on the panel to get a new one.');
      }

      if (args[0] === 'code' && i.isButton()) {
        return i.showModal(
          new ModalBuilder()
            .setCustomId('verify:submit')
            .setTitle('Verify')
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('code').setLabel('Type the code you were shown').setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(10).setRequired(true),
              ),
            ),
        );
      }

      if (args[0] === 'submit' && i.isModalSubmit()) {
        const typed = i.fields.getTextInputValue('code').replace(/\s/g, '').toUpperCase();
        if (typed !== pending.code) {
          pending.tries++;
          if (pending.tries >= 5) codes.delete(key);
          return fail(i, pending.tries >= 5 ? 'That didn’t match a few times. Press **Verify** to get a new code.' : 'That code doesn’t match. Press **Enter code** to try again.');
        }
        codes.delete(key);
        await grant(ctx, member, i.user.id);
        return ok(i, `You’re verified. Welcome to **${guild.name}**!`);
      }
    },
  },

  init(ctx) {
    ctx.client.on(Events.GuildMemberAdd, async (m) => {
      try {
        if (!ctx.enabled(m.guild.id, 'verification') || m.user.bot) return;
        const { unverifiedRoleId } = getSettings(ctx.db, m.guild.id, 'verification', verifyDefaults);
        if (unverifiedRoleId && m.guild.roles.cache.get(unverifiedRoleId)?.editable) await m.roles.add(unverifiedRoleId, 'Not verified yet');
      } catch (e) {
        console.warn('[verification] join:', e instanceof Error ? e.message : e);
      }
    });
  },

  async tick() {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  },
};
