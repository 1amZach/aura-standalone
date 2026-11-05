import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const CORE_SCHEMA = `
create table if not exists settings (
  guild_id text not null,
  key text not null,
  value text not null,
  primary key (guild_id, key)
);
`;

export function openDb(path: string, schemas: string[] = []): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(CORE_SCHEMA);
  for (const s of schemas) db.exec(s);
  return db;
}

export function all<T>(db: DB, sql: string, ...params: (string | number | bigint | null)[]): T[] {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }) as T);
}
export function get<T>(db: DB, sql: string, ...params: (string | number | bigint | null)[]): T | undefined {
  const r = db.prepare(sql).get(...params);
  return r ? ({ ...r } as T) : undefined;
}
export function run(db: DB, sql: string, ...params: (string | number | bigint | null)[]) {
  return db.prepare(sql).run(...params);
}

export function getSettings<T extends object>(db: DB, guildId: string, key: string, defaults: T): T {
  const row = get<{ value: string }>(db, 'select value from settings where guild_id = ? and key = ?', guildId, key);
  if (!row) return structuredClone(defaults);
  try {
    return { ...structuredClone(defaults), ...JSON.parse(row.value) };
  } catch {
    return structuredClone(defaults);
  }
}

export function setSettings<T extends object>(db: DB, guildId: string, key: string, defaults: T, patch: Partial<T>): T {
  const next = { ...getSettings(db, guildId, key, defaults), ...patch };
  run(db, 'insert into settings (guild_id, key, value) values (?, ?, ?) on conflict (guild_id, key) do update set value = excluded.value', guildId, key, JSON.stringify(next));
  return next;
}
