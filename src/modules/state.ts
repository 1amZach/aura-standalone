import { getSettings, setSettings, type DB } from '../db.js';
import type { Module } from '../types.js';

export function moduleEnabled(db: DB, all: Module[], guildId: string, id: string): boolean {
  const mod = all.find((m) => m.id === id);
  if (!mod) return false;
  if (mod.required) return true;
  const flags = getSettings<Record<string, boolean>>(db, guildId, 'modules', {});
  return flags[id] ?? mod.defaultOn;
}

export function setModuleEnabled(db: DB, guildId: string, id: string, on: boolean) {
  setSettings<Record<string, boolean>>(db, guildId, 'modules', {}, { [id]: on });
}
