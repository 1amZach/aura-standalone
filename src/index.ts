import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, type Guild, type EmbedBuilder, Partials, REST, Routes, type TextBasedChannel } from 'discord.js';
import { about } from './about.js';
import { loadConfig } from './config.js';
import { getSettings, openDb } from './db.js';
import { checkCore, modules } from './modules/index.js';
import { logDefaults } from './modules/logging.js';
import { moduleEnabled } from './modules/state.js';
import type { ComponentInteraction, Ctx, LogKind } from './types.js';
import { errEmbed, respond } from './util.js';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
  checkCore();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const db = openDb(config.databasePath, modules.flatMap((m) => (m.schema ? [m.schema] : [])));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: welcome, join roles, anti-raid, verification
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: automod, anti-scam, levelling
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: ['users'] },
});

// who handles what
const commandOwner = new Map<string, (typeof modules)[number]>();
const componentOwner = new Map<string, (typeof modules)[number]>();
for (const m of modules) {
  for (const c of m.commands ?? []) commandOwner.set(c.name, m);
  for (const key of Object.keys(m.components ?? {})) {
    if (componentOwner.has(key)) throw new Error(`Component key "${key}" is used by two modules`);
    componentOwner.set(key, m);
  }
}

let ctx: Ctx;

async function log(guild: Guild, kind: LogKind, entry: EmbedBuilder) {
  try {
    const cfg = getSettings(db, guild.id, 'logging', logDefaults);
    const id = cfg.channels[kind] || cfg.channels.fallback;
    if (!id) return;
    const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    if (ch?.isTextBased()) await (ch as TextBasedChannel & { send: Function }).send({ embeds: [entry.setTimestamp()], allowedMentions: { parse: [] } });
  } catch (e) {
    console.warn(`[log] ${guild.id} ${kind}:`, e instanceof Error ? e.message : e);
  }
}

client.once(Events.ClientReady, async (c) => {
  ctx = { client: c, db, config, log, enabled: (g, id) => moduleEnabled(db, modules, g, id) };
  for (const m of modules) m.init?.(ctx);

  // push commands on every boot so nobody has to remember a deploy step
  try {
    const body = modules.flatMap((m) => m.commands ?? []);
    const rest = new REST().setToken(config.token);
    await rest.put(config.devGuildId ? Routes.applicationGuildCommands(c.user.id, config.devGuildId) : Routes.applicationCommands(c.user.id), { body });
    console.log(`Synced ${body.length} slash commands${config.devGuildId ? ` to server ${config.devGuildId}` : ' globally'}.`);
  } catch (e) {
    console.error('Could not register slash commands:', e instanceof Error ? e.message : e);
  }

  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    for (const m of modules) {
      if (!m.tick) continue;
      try {
        await m.tick(ctx);
      } catch (e) {
        console.error(`[tick] ${m.id}:`, e);
      }
    }
    ticking = false;
  }, 15_000);

  c.user.setPresence({ activities: [{ name: about.status, type: ActivityType.Watching }] });
  console.log(`Aura Standalone is online as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
  console.log(`Built by ${about.author}. Need help? ${about.supportUrl}`);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!ctx || !i.inCachedGuild()) {
    if (i.isRepliable()) await i.reply({ content: 'Aura works inside servers only.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  try {
    if (i.isChatInputCommand()) {
      const m = commandOwner.get(i.commandName);
      const handler = m?.handle?.[i.commandName];
      if (!m || !handler) return;
      if (!ctx.enabled(i.guildId, m.id)) {
        await respond(i, { embeds: [errEmbed(`**${m.name}** is turned off here. An admin can turn it on with \`/module enable ${m.id}\`.`)] });
        return;
      }
      await handler(i, ctx);
    } else if (i.isAutocomplete()) {
      const m = commandOwner.get(i.commandName);
      await m?.autocomplete?.[i.commandName]?.(i, ctx);
    } else if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
      const [key, ...args] = i.customId.split(':');
      const m = componentOwner.get(key);
      const handler = m?.components?.[key];
      if (!m || !handler) return;
      if (!ctx.enabled(i.guildId, m.id)) {
        await respond(i, { embeds: [errEmbed(`**${m.name}** is turned off in this server.`)] });
        return;
      }
      await handler(i as ComponentInteraction, args, ctx);
    }
  } catch (e) {
    console.error(`[interaction] ${i.isChatInputCommand() ? `/${i.commandName}` : 'component'}:`, e);
    if (i.isRepliable()) await respond(i, { embeds: [errEmbed('Something went wrong running that. Check the bot has the permissions it needs, then try again.')] }).catch(() => {});
  }
});

client.on(Events.Error, (e) => console.error('[client]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

const shutdown = () => {
  client.destroy().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token).catch((e) => {
  console.error('Login failed:', e instanceof Error ? e.message : e);
  if (String(e).includes('disallowed intents')) console.error('Turn on the Server Members and Message Content intents for your bot in the Discord Developer Portal (Bot → Privileged Gateway Intents).');
  process.exit(1);
});
