import {
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type InteractionReplyOptions,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type RepliableInteraction,
} from 'discord.js';

export const colors = {
  primary: 0x7b2cff, // Aura violet
  blue: 0x3b82f6,
  cyan: 0x22d3ee,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  muted: 0x64748b,
} as const;

export const embed = (color: number = colors.primary) => new EmbedBuilder().setColor(color);
export const okEmbed = (text: string) => embed(colors.success).setDescription(`✅ ${text}`);
export const warnEmbed = (text: string) => embed(colors.warning).setDescription(`⚠️ ${text}`);
export const errEmbed = (text: string) => embed(colors.danger).setDescription(`⛔ ${text}`);

export async function respond(i: RepliableInteraction, opts: InteractionReplyOptions | string, ephemeral = true) {
  const o: InteractionReplyOptions = typeof opts === 'string' ? { content: opts } : opts;
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  if (i.deferred && !i.replied) return i.editReply(o as never);
  if (i.replied || i.deferred) return i.followUp({ ...o, flags } as never);
  return i.reply({ ...o, flags } as never);
}
export const ok = (i: RepliableInteraction, text: string, ephemeral = true) => respond(i, { embeds: [okEmbed(text)] }, ephemeral);
export const fail = (i: RepliableInteraction, text: string) => respond(i, { embeds: [errEmbed(text)] }, true);

export function parseDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const units: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 };
  let total = 0;
  let rest = s;
  const re = /^(\d+(?:\.\d+)?)(s|m|h|d|w)/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * units[m[2]];
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}

export function fmtDuration(ms: number): string {
  const parts: string[] = [];
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  const s = Math.floor((ms % 60e3) / 1e3);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}

export const ts = (ms: number, style: 'R' | 'f' | 'F' | 'd' | 'D' | 't' = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-z_.]+)\}/gi, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function memberVars(member: GuildMember | { id: string; user: { username: string }; guild: Guild }) {
  return {
    user: `<@${member.id}>`,
    'user.name': member.user.username,
    'user.id': member.id,
    server: member.guild.name,
    count: member.guild.memberCount,
  };
}

// returns the reason they can't, or null if it's fine
export function canModerate(actor: GuildMember, target: GuildMember): string | null {
  if (actor.id === target.id) return 'You can’t do that to yourself.';
  if (target.id === target.guild.ownerId) return 'You can’t do that to the server owner.';
  if (target.id === target.client.user.id) return 'Nice try.';
  if (actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
    return 'Their highest role is the same as or above yours.';
  const me = target.guild.members.me;
  if (me && me.roles.highest.comparePositionTo(target.roles.highest) <= 0) return 'Their highest role is the same as or above mine, so I can’t act on them.';
  return null;
}

export const isAdmin = (i: ChatInputCommandInteraction) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function pickRandom<T>(items: T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}
