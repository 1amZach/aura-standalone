import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'discord.js';
import { about } from './about.js';
import type { BotConfig } from './config.js';
import { getSettings, setSettings, type DB } from './db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = about.repoUrl.replace('https://github.com/', '');

export let latest: { version: string; url: string } | null = null;

export function isNewer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'aura-standalone', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name: string; html_url: string };
  return { version: body.tag_name.replace(/^v/, ''), url: body.html_url };
}

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'pipe', encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const git = (...args: string[]) => run('git', args);
const npm = (...args: string[]) => run('npm', args);

// pm2, systemd, or anything else that sets AURA_MANAGED will bring us back up after exit
const restartsItself = () => !!(process.env.pm_id || process.env.INVOCATION_ID || process.env.AURA_MANAGED);

function install(version: string): string | null {
  if (!existsSync(join(root, '.git'))) return 'this copy wasn’t installed with git clone';
  if (git('status', '--porcelain', '--untracked-files=no')) return 'the code has local changes, so it won’t be overwritten';
  const before = git('rev-parse', 'HEAD');
  try {
    git('fetch', '--tags', '--force', 'origin');
    git('-c', 'advice.detachedHead=false', 'checkout', '--quiet', `v${version}`);
    npm('ci', '--no-audit', '--no-fund');
    npm('run', 'build');
    return null;
  } catch (e) {
    try {
      git('checkout', '--quiet', before);
      npm('ci', '--no-audit', '--no-fund');
    } catch {}
    const out = e as { stderr?: string; message?: string };
    return (out.stderr || out.message || 'unknown error').split('\n').slice(-5).join(' ').trim();
  }
}

async function tellOwners(client: Client<true>, config: BotConfig, text: string) {
  const ids = new Set(config.ownerIds);
  const app = await client.application.fetch().catch(() => null);
  const owner = app?.owner;
  if (owner && 'members' in owner) owner.members.forEach((m) => ids.add(m.id));
  else if (owner) ids.add(owner.id);
  for (const id of ids) {
    const user = await client.users.fetch(id).catch(() => null);
    await user?.send(text).catch(() => {});
  }
}

export async function checkForUpdate(client: Client<true>, config: BotConfig, db: DB) {
  const rel = await latestRelease().catch(() => null);
  if (!rel || !isNewer(rel.version, about.version)) return;
  latest = rel;

  const seen = getSettings(db, '_global', 'updater', { told: '' });
  if (seen.told !== rel.version) {
    setSettings(db, '_global', 'updater', { told: '' }, { told: rel.version });
    console.log(`Aura v${rel.version} is out (you’re on v${about.version}): ${rel.url}`);
    const how = config.autoUpdate ? 'It’ll install itself shortly.' : 'Run `git pull && npm install && npm run build` and restart, or turn on `autoUpdate` in config.json.';
    await tellOwners(client, config, `**Aura v${rel.version} is out.** You’re on v${about.version}. ${how}\n${rel.url}`);
  }

  if (!config.autoUpdate) return;
  if (existsSync('/.dockerenv')) {
    console.log('Running in Docker, so updates come from the image. Add Watchtower to update automatically (see the README).');
    return;
  }

  console.log(`Updating to v${rel.version}…`);
  const problem = install(rel.version);
  if (problem) {
    console.warn(`Couldn’t update to v${rel.version}: ${problem}. Still running v${about.version}.`);
    return;
  }
  if (restartsItself()) {
    console.log(`Updated to v${rel.version}. Restarting…`);
    await client.destroy().catch(() => {});
    process.exit(0);
  }
  console.log(`Updated to v${rel.version}. Restart the bot to finish.`);
}

export function startUpdater(client: Client<true>, config: BotConfig, db: DB) {
  if (!config.updateCheck) return;
  const check = () => checkForUpdate(client, config, db).catch((e) => console.warn('[updater]', e instanceof Error ? e.message : e));
  setTimeout(check, 60_000);
  setInterval(check, 6 * 3600e3);
}
