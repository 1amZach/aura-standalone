import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import { all, get, run, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, ok, respond, truncate } from '../util.js';

const schema = `
create table if not exists roles_join (
  guild_id text not null,
  role_id text not null,
  target text not null default 'humans',
  primary key (guild_id, role_id, target)
);
create table if not exists roles_panels (
  id integer primary key autoincrement,
  guild_id text not null,
  title text not null,
  description text not null default '',
  mode text not null default 'normal',
  channel_id text,
  message_id text,
  created_at integer not null
);
create index if not exists roles_panels_guild on roles_panels (guild_id);
create table if not exists roles_panel_items (
  panel_id integer not null references roles_panels (id) on delete cascade,
  role_id text not null,
  label text not null,
  emoji text,
  style text not null default 'secondary',
  position integer not null,
  primary key (panel_id, role_id)
);
`;

export type PanelMode = 'normal' | 'unique' | 'add-only';
interface PanelRow {
  id: number;
  guild_id: string;
  title: string;
  description: string;
  mode: PanelMode;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
}
interface ItemRow {
  panel_id: number;
  role_id: string;
  label: string;
  emoji: string | null;
  style: 'primary' | 'secondary' | 'success' | 'danger';
  position: number;
}

export const MAX_PANEL_ROLES = 25;

export function planToggle(mode: PanelMode, held: string[], roleId: string): { add: string[]; remove: string[] } {
  const has = held.includes(roleId);
  if (mode === 'add-only') return { add: has ? [] : [roleId], remove: [] };
  if (has) return { add: [], remove: [roleId] };
  if (mode === 'unique') return { add: [roleId], remove: held.filter((r) => r !== roleId) };
  return { add: [roleId], remove: [] };
}

export function chunk<T>(items: T[], size = 5): T[][] {
  const out: T[][] = [];
  for (let n = 0; n < items.length; n += size) out.push(items.slice(n, n + size));
  return out;
}

export function looksLikeEmoji(s: string): boolean {
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(s)) return true;
  return s.length > 0 && s.length <= 16 && !/[\w\s<>:]/.test(s);
}

const STYLE: Record<ItemRow['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
const MODE_TEXT: Record<PanelMode, string> = {
  normal: 'Click a button to get the role, click again to remove it.',
  unique: 'You can have one of these at a time. Picking another swaps it.',
  'add-only': 'Click a button to get the role. These can’t be removed here.',
};

const panelOpt = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('panel').setDescription('Panel id').setRequired(true).setAutocomplete(true);

const commands = [
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Roles given to everyone who joins')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Give a role to new members')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption((o) => o.setName('for').setDescription('Who gets it (default humans)').addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' })),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop giving a role to new members')
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption((o) => o.setName('for').setDescription('Humans or bots (default both)').addChoices({ name: 'Humans', value: 'humans' }, { name: 'Bots', value: 'bots' })),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show join roles')),
  new SlashCommandBuilder()
    .setName('rolepanel')
    .setDescription('Button panels people use to pick their own roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Start a new panel')
        .addStringOption((o) => o.setName('title').setDescription('Panel title').setRequired(true).setMaxLength(256))
        .addStringOption((o) => o.setName('description').setDescription('Text under the title').setMaxLength(2000))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('How the buttons behave (default normal)')
            .addChoices({ name: 'Normal: toggle any', value: 'normal' }, { name: 'Unique: one at a time', value: 'unique' }, { name: 'Add only', value: 'add-only' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a role button to a panel')
        .addIntegerOption(panelOpt)
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Button text (default the role name)').setMaxLength(80))
        .addStringOption((o) => o.setName('emoji').setDescription('Button emoji'))
        .addStringOption((o) =>
          o
            .setName('style')
            .setDescription('Button colour (default grey)')
            .addChoices({ name: 'Grey', value: 'secondary' }, { name: 'Blurple', value: 'primary' }, { name: 'Green', value: 'success' }, { name: 'Red', value: 'danger' }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a role button from a panel')
        .addIntegerOption(panelOpt)
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('post')
        .setDescription('Post the panel, or update it if it’s already posted')
        .addIntegerOption(panelOpt)
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show this server’s panels'))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a panel and its message').addIntegerOption(panelOpt)),
];

const getPanel = (db: DB, guildId: string, id: number) => get<PanelRow>(db, 'select * from roles_panels where id = ? and guild_id = ?', id, guildId);
const getItems = (db: DB, panelId: number) => all<ItemRow>(db, 'select * from roles_panel_items where panel_id = ? order by position, rowid', panelId);

function roleProblem(guild: Guild, role: Role): string | null {
  if (role.id === guild.id) return 'That’s @everyone, which everyone already has.';
  if (role.managed) return `<@&${role.id}> is managed by an integration or bot, so it can’t be given out.`;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return 'I need the Manage Roles permission.';
  if (me.roles.highest.comparePositionTo(role) <= 0) return `<@&${role.id}> is above my highest role. Move my role above it in Server Settings → Roles.`;
  return null;
}

function panelMessage(panel: PanelRow, items: ItemRow[]) {
  const e = embed(colors.primary)
    .setTitle(panel.title)
    .setDescription(truncate(`${panel.description ? `${panel.description}\n\n` : ''}${items.map((it) => `${it.emoji ? `${it.emoji} ` : ''}<@&${it.role_id}>`).join('\n')}`, 4096) || MODE_TEXT[panel.mode])
    .setFooter({ text: MODE_TEXT[panel.mode] });
  const rows = chunk(items).map((group) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      group.map((it) => {
        const b = new ButtonBuilder().setCustomId(`rp:${panel.id}:${it.role_id}`).setLabel(it.label).setStyle(STYLE[it.style] ?? ButtonStyle.Secondary);
        if (it.emoji) b.setEmoji(it.emoji);
        return b;
      }),
    ),
  );
  return { embeds: [e], components: rows, allowedMentions: { parse: [] } };
}

// don't spam the log on every join
const warned = new Map<string, number>();
async function warnOnce(ctx: Ctx, guild: Guild, key: string, text: string) {
  const last = warned.get(key) ?? 0;
  if (Date.now() - last < 3600e3) return;
  warned.set(key, Date.now());
  await ctx.log(guild, 'server', embed(colors.warning).setTitle('Join role skipped').setDescription(`⚠️ ${text}`));
}

async function giveJoinRoles(ctx: Ctx, member: GuildMember, target: 'humans' | 'bots') {
  const ids = all<{ role_id: string }>(ctx.db, 'select role_id from roles_join where guild_id = ? and target = ?', member.guild.id, target).map((r) => r.role_id);
  const give: string[] = [];
  for (const id of ids) {
    if (member.roles.cache.has(id)) continue;
    const role = member.guild.roles.cache.get(id);
    if (!role) {
      run(ctx.db, 'delete from roles_join where guild_id = ? and role_id = ?', member.guild.id, id);
      continue;
    }
    const why = roleProblem(member.guild, role);
    if (why) {
      await warnOnce(ctx, member.guild, `${member.guild.id}:${id}`, `I couldn’t give <@&${id}> to new members. ${why}`);
      continue;
    }
    give.push(id);
  }
  if (give.length) await member.roles.add(give, 'Join roles');
}

export const rolesModule: Module = {
  id: 'roles',
  name: 'Roles',
  description: 'Roles given on join (waiting for membership screening), and button panels people use to pick their own roles.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async autorole(i, { db }) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const rows = all<{ role_id: string; target: string }>(db, 'select role_id, target from roles_join where guild_id = ? order by target', i.guildId);
        const humans = rows.filter((r) => r.target === 'humans').map((r) => `<@&${r.role_id}>`);
        const bots = rows.filter((r) => r.target === 'bots').map((r) => `<@&${r.role_id}>`);
        return respond(i, {
          embeds: [
            embed()
              .setTitle('Join roles')
              .addFields({ name: 'Humans', value: humans.join(', ') || 'None' }, { name: 'Bots', value: bots.join(', ') || 'None' })
              .setFooter({ text: 'Humans get theirs after passing membership screening, if it’s on.' }),
          ],
        });
      }
      const role = i.options.getRole('role', true);
      const target = i.options.getString('for');
      if (sub === 'add') {
        const why = roleProblem(i.guild, role);
        if (why) return fail(i, why);
        const t = target ?? 'humans';
        run(db, 'insert or ignore into roles_join (guild_id, role_id, target) values (?, ?, ?)', i.guildId, role.id, t);
        return ok(i, `New ${t} will get <@&${role.id}> when they join.`);
      }
      const res = target
        ? run(db, 'delete from roles_join where guild_id = ? and role_id = ? and target = ?', i.guildId, role.id, target)
        : run(db, 'delete from roles_join where guild_id = ? and role_id = ?', i.guildId, role.id);
      if (!res.changes) return fail(i, `<@&${role.id}> isn’t a join role${target ? ` for ${target}` : ''}.`);
      return ok(i, `<@&${role.id}> won’t be given on join any more.`);
    },

    async rolepanel(i, { db }) {
      const sub = i.options.getSubcommand();

      if (sub === 'create') {
        const title = i.options.getString('title', true);
        const description = i.options.getString('description') ?? '';
        const mode = (i.options.getString('mode') ?? 'normal') as PanelMode;
        const res = run(db, 'insert into roles_panels (guild_id, title, description, mode, created_at) values (?, ?, ?, ?, ?)', i.guildId, title, description, mode, Date.now());
        const id = Number(res.lastInsertRowid);
        return ok(i, `Created panel **#${id}**. Add roles with \`/rolepanel add panel:${id}\`, then post it with \`/rolepanel post panel:${id}\`.`);
      }

      if (sub === 'list') {
        const panels = all<PanelRow & { n: number }>(
          db,
          'select p.*, (select count(*) from roles_panel_items it where it.panel_id = p.id) as n from roles_panels p where guild_id = ? order by id',
          i.guildId,
        );
        if (!panels.length) return respond(i, { embeds: [embed(colors.muted).setDescription('No panels yet. Make one with `/rolepanel create`.')] });
        const lines = panels.map(
          (p) => `**#${p.id}** ${truncate(p.title, 60)} · ${p.mode} · ${p.n} role(s) · ${p.channel_id && p.message_id ? `posted in <#${p.channel_id}>` : 'not posted'}`,
        );
        return respond(i, { embeds: [embed().setTitle('Role panels').setDescription(truncate(lines.join('\n'), 4096))] });
      }

      const panel = getPanel(db, i.guildId, i.options.getInteger('panel', true));
      if (!panel) return fail(i, 'I can’t find that panel. See yours with `/rolepanel list`.');
      const items = getItems(db, panel.id);

      if (sub === 'add') {
        const role = i.options.getRole('role', true);
        const why = roleProblem(i.guild, role);
        if (why) return fail(i, why);
        const exists = items.some((it) => it.role_id === role.id);
        if (!exists && items.length >= MAX_PANEL_ROLES) return fail(i, `A panel can hold up to ${MAX_PANEL_ROLES} roles.`);
        const emoji = i.options.getString('emoji')?.trim() || null;
        if (emoji && !looksLikeEmoji(emoji)) return fail(i, 'That doesn’t look like an emoji. Use a normal emoji or a custom one like <:name:id>.');
        const label = i.options.getString('label') ?? truncate(role.name, 80);
        const style = i.options.getString('style') ?? 'secondary';
        run(
          db,
          `insert into roles_panel_items (panel_id, role_id, label, emoji, style, position) values (?, ?, ?, ?, ?, ?)
           on conflict (panel_id, role_id) do update set label = excluded.label, emoji = excluded.emoji, style = excluded.style`,
          panel.id, role.id, label, emoji, style, items.length,
        );
        return ok(i, `${exists ? 'Updated' : 'Added'} <@&${role.id}> on panel **#${panel.id}**.${panel.message_id ? ' Run `/rolepanel post` again to update the posted message.' : ''}`);
      }

      if (sub === 'remove') {
        const role = i.options.getRole('role', true);
        const res = run(db, 'delete from roles_panel_items where panel_id = ? and role_id = ?', panel.id, role.id);
        if (!res.changes) return fail(i, `<@&${role.id}> isn’t on panel **#${panel.id}**.`);
        return ok(i, `Removed <@&${role.id}> from panel **#${panel.id}**.${panel.message_id ? ' Run `/rolepanel post` again to update the posted message.' : ''}`);
      }

      if (sub === 'post') {
        if (!items.length) return fail(i, `Panel **#${panel.id}** has no roles yet. Add some with \`/rolepanel add\`.`);
        const ch = i.options.getChannel('channel') ?? i.channel;
        if (!ch || !('send' in ch) || !ch.isTextBased()) return fail(i, 'I can’t post in that channel.');
        const me = i.guild.members.me;
        if (!me || !ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
          return fail(i, `I need View Channel, Send Messages and Embed Links in <#${ch.id}>.`);
        const payload = panelMessage(panel, items);
        try {
          if (panel.message_id && panel.channel_id === ch.id) {
            const existing = await ch.messages.fetch(panel.message_id).catch(() => null);
            if (existing) {
              await existing.edit(payload);
              return ok(i, `Updated panel **#${panel.id}** in <#${ch.id}>.`);
            }
          }
          const msg = await ch.send(payload);
          run(db, 'update roles_panels set channel_id = ?, message_id = ? where id = ?', ch.id, msg.id, panel.id);
          return ok(i, `Posted panel **#${panel.id}** in <#${ch.id}>.`);
        } catch (e) {
          console.warn('[roles] post panel:', e instanceof Error ? e.message : e);
          return fail(i, 'Discord wouldn’t accept that panel. Check the button emojis are valid and ones I can use.');
        }
      }

      if (panel.channel_id && panel.message_id) {
        const ch = i.guild.channels.cache.get(panel.channel_id);
        if (ch?.isTextBased()) await ch.messages.delete(panel.message_id).catch(() => {});
      }
      run(db, 'delete from roles_panels where id = ?', panel.id);
      return ok(i, `Deleted panel **#${panel.id}**.`);
    },
  },
  autocomplete: {
    async rolepanel(i, { db }) {
      const q = String(i.options.getFocused()).toLowerCase();
      const panels = all<{ id: number; title: string }>(db, 'select id, title from roles_panels where guild_id = ? order by id desc limit 100', i.guildId);
      await i.respond(
        panels
          .filter((p) => !q || String(p.id).startsWith(q) || p.title.toLowerCase().includes(q))
          .slice(0, 25)
          .map((p) => ({ name: truncate(`#${p.id} ${p.title}`, 100), value: p.id })),
      );
    },
  },
  components: {
    async rp(i, args, { db }) {
      if (!i.isButton() || !i.inCachedGuild()) return;
      const [panelIdRaw, roleId] = args;
      const panel = getPanel(db, i.guildId, Number(panelIdRaw));
      if (!panel) return fail(i, 'This panel doesn’t exist any more.');
      const items = getItems(db, panel.id);
      if (!items.some((it) => it.role_id === roleId)) return fail(i, 'That role isn’t on this panel any more.');
      const role = i.guild.roles.cache.get(roleId);
      if (!role) return fail(i, 'That role doesn’t exist any more. Let a staff member know.');
      const why = roleProblem(i.guild, role);
      if (why) return fail(i, `I can’t give that role right now. Let a staff member know: ${why}`);

      const member = i.member;
      const held = items.map((it) => it.role_id).filter((id) => member.roles.cache.has(id));
      const plan = planToggle(panel.mode, held, roleId);
      const remove = plan.remove.filter((id) => {
        const r = i.guild.roles.cache.get(id);
        return r && !roleProblem(i.guild, r);
      });
      if (!plan.add.length && !remove.length) return respond(i, { embeds: [embed(colors.muted).setDescription(`You already have <@&${roleId}>.`)] });
      try {
        if (remove.length) await member.roles.remove(remove, `Role panel #${panel.id}`);
        if (plan.add.length) await member.roles.add(plan.add, `Role panel #${panel.id}`);
      } catch (e) {
        console.warn('[roles] panel toggle:', e instanceof Error ? e.message : e);
        return fail(i, 'I couldn’t change your roles. Let a staff member know.');
      }
      const parts: string[] = [];
      if (plan.add.length) parts.push(`Gave you ${plan.add.map((r) => `<@&${r}>`).join(', ')}.`);
      if (remove.length) parts.push(`Removed ${remove.map((r) => `<@&${r}>`).join(', ')}.`);
      return ok(i, parts.join(' '));
    },
  },
  init(ctx) {
    ctx.client.on(Events.GuildMemberAdd, async (member) => {
      try {
        if (!ctx.enabled(member.guild.id, 'roles')) return;
        if (member.user.bot) return await giveJoinRoles(ctx, member, 'bots');
        if (member.pending) return; // given once they pass membership screening
        await giveJoinRoles(ctx, member, 'humans');
      } catch (e) {
        console.warn('[roles] join roles:', e instanceof Error ? e.message : e);
      }
    });

    ctx.client.on(Events.GuildMemberUpdate, async (before, after) => {
      try {
        if (!ctx.enabled(after.guild.id, 'roles')) return;
        if (after.user.bot || after.pending) return;
        // before can be partial; giveJoinRoles skips roles they already have anyway
        if (before.pending === false) return;
        await giveJoinRoles(ctx, after, 'humans');
      } catch (e) {
        console.warn('[roles] screening roles:', e instanceof Error ? e.message : e);
      }
    });

    ctx.client.on(Events.GuildRoleDelete, (role) => {
      try {
        if (!ctx.enabled(role.guild.id, 'roles')) return;
        run(ctx.db, 'delete from roles_join where guild_id = ? and role_id = ?', role.guild.id, role.id);
      } catch (e) {
        console.warn('[roles] role delete:', e instanceof Error ? e.message : e);
      }
    });
  },
};
