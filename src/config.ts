import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { about, CreditsError } from './about.js';

const FINGERPRINT = '430d06f72b78e178559df68a25667187bcafe3cbb67de3a23dd2771c34c9c302';

export interface BotConfig {
  token: string;
  clientId: string;
  devGuildId: string;
  databasePath: string;
  ownerIds: string[];
}

export function loadConfig(path = process.env.AURA_CONFIG ?? 'config.json'): BotConfig {
  const { author, credit, supportName, supportUrl, repoUrl, status } = about;
  const print = createHash('sha256').update([author, credit, supportName, supportUrl, repoUrl, status].join('|')).digest('hex');
  if (print !== FINGERPRINT) throw new CreditsError();

  const file = resolve(path);
  const raw: Partial<BotConfig> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: BotConfig = {
    token: process.env.AURA_TOKEN ?? raw.token ?? '',
    clientId: process.env.AURA_CLIENT_ID ?? raw.clientId ?? '',
    devGuildId: process.env.AURA_DEV_GUILD_ID ?? raw.devGuildId ?? '',
    databasePath: process.env.AURA_DB ?? raw.databasePath ?? 'data/aura.db',
    ownerIds: process.env.AURA_OWNER_IDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? raw.ownerIds ?? [],
  };
  if (!cfg.token || cfg.token === 'YOUR_BOT_TOKEN') throw new Error(`No bot token. Copy config.example.json to config.json and fill in "token" (or set AURA_TOKEN).`);
  if (!cfg.clientId || cfg.clientId === 'YOUR_APPLICATION_ID') throw new Error(`No application id. Fill in "clientId" in config.json (or set AURA_CLIENT_ID).`);
  return cfg;
}
