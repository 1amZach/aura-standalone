import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { about, CreditsError } from './about.js';

const FINGERPRINT = 'e05ac6fb24465afe39a6ea15f11e0272a3e69f17ddc50eb6e3e8fc68350b4240';

export interface BotConfig {
  token: string;
  clientId: string;
  devGuildId: string;
  databasePath: string;
  ownerIds: string[];
  updateCheck: boolean;
  autoUpdate: boolean;
}

const flag = (v?: string) => (v === undefined || v === '' ? undefined : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(path = process.env.AURA_CONFIG ?? 'config.json'): BotConfig {
  const { author, credit, supportName, supportUrl, repoUrl, statuses } = about;
  const print = createHash('sha256').update([author, credit, supportName, supportUrl, repoUrl, ...statuses].join('|')).digest('hex');
  if (print !== FINGERPRINT) throw new CreditsError();

  const file = resolve(path);
  const raw: Partial<BotConfig> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: BotConfig = {
    token: process.env.AURA_TOKEN ?? raw.token ?? '',
    clientId: process.env.AURA_CLIENT_ID ?? raw.clientId ?? '',
    devGuildId: process.env.AURA_DEV_GUILD_ID ?? raw.devGuildId ?? '',
    databasePath: process.env.AURA_DB ?? raw.databasePath ?? 'data/aura.db',
    ownerIds: process.env.AURA_OWNER_IDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? raw.ownerIds ?? [],
    updateCheck: flag(process.env.AURA_UPDATE_CHECK) ?? raw.updateCheck ?? true,
    autoUpdate: flag(process.env.AURA_AUTO_UPDATE) ?? raw.autoUpdate ?? false,
  };
  if (!cfg.token || cfg.token === 'YOUR_BOT_TOKEN') throw new Error(`No bot token. Copy config.example.json to config.json and fill in "token" (or set AURA_TOKEN).`);
  if (!cfg.clientId || cfg.clientId === 'YOUR_APPLICATION_ID') throw new Error(`No application id. Fill in "clientId" in config.json (or set AURA_CLIENT_ID).`);
  return cfg;
}
