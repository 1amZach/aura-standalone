import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { modules } from './modules/index.js';

export async function deployCommands() {
  const config = loadConfig();
  const body = modules.flatMap((m) => m.commands ?? []);
  const names = new Set<string>();
  for (const c of body) {
    if (names.has(c.name)) throw new Error(`Two modules define /${c.name}`);
    names.add(c.name);
  }
  const rest = new REST().setToken(config.token);
  const route = config.devGuildId ? Routes.applicationGuildCommands(config.clientId, config.devGuildId) : Routes.applicationCommands(config.clientId);
  await rest.put(route, { body });
  console.log(`Registered ${body.length} commands ${config.devGuildId ? `in server ${config.devGuildId}` : 'globally (may take up to an hour to appear)'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deployCommands().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
