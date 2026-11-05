import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder, type PermissionsBitField } from 'discord.js';
import { all, get, run, type DB } from '../db.js';
import type { Ctx, Module } from '../types.js';
import { colors, embed, fail, fmtDuration, ok, parseDuration, respond, truncate, ts } from '../util.js';

export function splitOptions(raw: string): string[] {
  const sep = raw.includes('|') ? '|' : ',';
  return raw
    .split(sep)
    .map((o) => o.trim())
    .filter(Boolean);
}

export function tally(optionCount: number, votes: number[]) {
  const counts = Array.from({ length: optionCount }, () => 0);
  for (const v of votes) if (v >= 0 && v < optionCount) counts[v]++;
  const total = counts.reduce((a, b) => a + b, 0);
  const percents = counts.map((c) => (total ? Math.round((c / total) * 100) : 0));
  const top = Math.max(0, ...counts);
  const winners = top > 0 ? counts.flatMap((c, i) => (c === top ? [i] : [])) : [];
  return { counts, total, percents, winners };
}

export const bar = (pct: number, len = 12) => {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * len);
  return '█'.repeat(n) + '░'.repeat(len - n);
};

// max one edit per message every ~2s, the callback reads fresh state so votes in between get folded in
const pending = new Set<string>();
const lastRun = new Map<string, number>();
export function throttledEdit(key: string, fn: () => Promise<unknown>, gap = 2000) {
  if (pending.has(key)) return;
  pending.add(key);
  const wait = Math.max(0, (lastRun.get(key) ?? 0) + gap - Date.now());
  setTimeout(() => {
    pending.delete(key);
    lastRun.set(key, Date.now());
    fn().catch((e) => console.warn(`[edit] ${key}:`, e instanceof Error ? e.message : e));
  }, wait);
}

const schema = `
create table if not exists polls_list (
  id integer primary key autoincrement,
  guild_id text not null,
  channel_id text not null,
  message_id text,
  creator_id text not null,
  question text not null,
  options text not null,
  multi integer not null default 0,
  anonymous integer not null default 1,
  ends_at integer not null,
  ended integer not null default 0,
  created_at integer not null
);
create index if not exists polls_open on polls_list (ends_at) where ended = 0;
create table if not exists polls_votes (
  poll_id integer not null references polls_list (id) on delete cascade,
  user_id text not null,
  option_index integer not null,
  voted_at integer not null,
  primary key (poll_id, user_id, option_index)
);
`;

interface PollRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  creator_id: string;
  question: string;
  options: string;
  multi: number;
  anonymous: number;
  ends_at: number;
  ended: number;
  created_at: number;
}

const getPoll = (db: DB, id: number) => get<PollRow>(db, 'select * from polls_list where id = ?', id);
const votesFor = (db: DB, id: number) => all<{ user_id: string; option_index: number }>(db, 'select user_id, option_index from polls_votes where poll_id = ?', id);

function pollView(db: DB, p: PollRow) {
  const options: string[] = JSON.parse(p.options);
  const votes = votesFor(db, p.id);
  const t = tally(options.length, votes.map((v) => v.option_index));
  const voters = new Set(votes.map((v) => v.user_id)).size;
  const closed = !!p.ended;

  const lines = options.map((o, n) => {
    const win = closed && t.winners.includes(n);
    const label = `${win ? '🏆 ' : ''}**${n + 1}. ${truncate(o, 100)}**`;
    return `${label}\n\`${bar(t.percents[n])}\` ${t.percents[n]}% · ${t.counts[n]} vote${t.counts[n] === 1 ? '' : 's'}`;
  });
  const e = embed(closed ? colors.muted : colors.blue)
    .setTitle(`📊 ${truncate(p.question, 250)}`)
    .setDescription(lines.join('\n\n'))
    .addFields({ name: closed ? 'Ended' : 'Ends', value: `${ts(p.ends_at, 'R')}`, inline: true }, { name: 'Asked by', value: `<@${p.creator_id}>`, inline: true })
    .setFooter({ text: `Poll #${p.id} · ${p.multi ? 'Pick as many as you like' : 'Pick one'} · ${p.anonymous ? 'Anonymous' : 'Votes visible to the creator'} · ${voters} voter${voters === 1 ? '' : 's'}` });
  if (closed) {
    const result = t.winners.length ? t.winners.map((n) => `**${truncate(options[n], 100)}**`).join(' and ') : 'nobody voted';
    e.addFields({ name: 'Result', value: t.winners.length > 1 ? `Tie between ${result}` : t.winners.length ? `${result} wins` : 'Nobody voted' });
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  options.forEach((o, n) => {
    if (n % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:vote:${p.id}:${n}`)
        .setLabel(truncate(`${n + 1}. ${o}`, 80))
        .setStyle(closed && t.winners.includes(n) ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(closed),
    );
  });
  if (!p.anonymous)
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`poll:voters:${p.id}`).setLabel('See voters').setEmoji('👀').setStyle(ButtonStyle.Primary)));
  return { embeds: [e], components: rows, allowedMentions: { parse: [] } };
}

async function refresh(ctx: Ctx, id: number) {
  const p = getPoll(ctx.db, id);
  if (!p?.message_id) return;
  const ch = await ctx.client.channels.fetch(p.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(p.message_id).catch(() => null);
  if (msg) await msg.edit(pollView(ctx.db, p));
}

async function closePoll(ctx: Ctx, id: number) {
  run(ctx.db, 'update polls_list set ended = 1 where id = ?', id);
  await refresh(ctx, id).catch((e) => console.warn(`[polls] close ${id}:`, e instanceof Error ? e.message : e));
}

const canManage = (i: { user: { id: string }; memberPermissions: Readonly<PermissionsBitField> | null }, p: PollRow) =>
  i.user.id === p.creator_id || !!i.memberPermissions?.has(PermissionFlagsBits.ManageMessages);

const commands = [
  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Run a poll')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Start a poll in this channel')
        .addStringOption((o) => o.setName('question').setDescription('What are you asking?').setRequired(true).setMaxLength(250))
        .addStringOption((o) => o.setName('options').setDescription('2 to 10 choices, split with | or commas').setRequired(true).setMaxLength(1000))
        .addStringOption((o) => o.setName('duration').setDescription('How long it runs, e.g. 30m, 2h, 3d (default 1d, max 30d)'))
        .addBooleanOption((o) => o.setName('multiple_choice').setDescription('Let people pick more than one'))
        .addBooleanOption((o) => o.setName('anonymous').setDescription('Hide who voted for what (default yes)')),
    )
    .addSubcommand((s) =>
      s
        .setName('end')
        .setDescription('Close a poll early')
        .addIntegerOption((o) => o.setName('id').setDescription('Poll number (shown in the poll’s footer)').setRequired(true)),
    ),
];

export const pollsModule: Module = {
  id: 'polls',
  name: 'Polls',
  description: 'Button polls with live results, single or multiple choice, anonymous or not.',
  defaultOn: true,
  schema,
  commands: commands.map((c) => c.toJSON()),
  handle: {
    async poll(i, ctx) {
      const { db } = ctx;
      if (i.options.getSubcommand() === 'end') {
        const p = getPoll(db, i.options.getInteger('id', true));
        if (!p || p.guild_id !== i.guildId) return fail(i, 'I couldn’t find that poll.');
        if (p.ended) return fail(i, 'That poll has already ended.');
        if (!canManage(i, p)) return fail(i, 'Only the person who made the poll, or someone with Manage Messages, can end it.');
        await closePoll(ctx, p.id);
        return ok(i, `Poll #${p.id} is closed.`);
      }

      const options = splitOptions(i.options.getString('options', true));
      if (options.length < 2 || options.length > 10) return fail(i, 'Give between 2 and 10 options, split with `|` or commas.');
      const raw = i.options.getString('duration');
      const ms = raw ? parseDuration(raw) : 86400e3;
      if (!ms || ms > 30 * 86400e3 || ms < 60e3) return fail(i, 'Give a length like `30m`, `2h` or `3d`, between 1 minute and 30 days.');
      if (!i.channel?.isSendable()) return fail(i, 'I can’t post here.');

      const now = Date.now();
      const res = run(
        db,
        'insert into polls_list (guild_id, channel_id, creator_id, question, options, multi, anonymous, ends_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        i.guildId, i.channelId, i.user.id, i.options.getString('question', true), JSON.stringify(options),
        i.options.getBoolean('multiple_choice') ? 1 : 0, i.options.getBoolean('anonymous') === false ? 0 : 1, now + ms, now,
      );
      const id = Number(res.lastInsertRowid);
      const msg = await i.channel.send(pollView(db, getPoll(db, id)!)).catch(() => null);
      if (!msg) {
        run(db, 'delete from polls_list where id = ?', id);
        return fail(i, 'I couldn’t post the poll here. Check I can send messages and embed links in this channel.');
      }
      run(db, 'update polls_list set message_id = ? where id = ?', msg.id, id);
      return ok(i, `Poll #${id} is up and runs for ${fmtDuration(ms)}.`);
    },
  },
  components: {
    async poll(i, [action, rawId, rawIdx], ctx) {
      if (!i.isButton() || !i.inCachedGuild()) return;
      const { db } = ctx;
      const p = getPoll(db, Number(rawId));
      if (!p) return fail(i, 'This poll doesn’t exist anymore.');
      const options: string[] = JSON.parse(p.options);

      if (action === 'voters') {
        if (p.anonymous) return fail(i, 'This poll is anonymous.');
        if (!canManage(i, p)) return fail(i, 'Only the person who made the poll can see who voted.');
        const votes = votesFor(db, p.id);
        const e = embed(colors.blue).setTitle(`Voters: ${truncate(p.question, 200)}`);
        for (const [n, o] of options.entries()) {
          const who = votes.filter((v) => v.option_index === n).map((v) => `<@${v.user_id}>`);
          e.addFields({ name: truncate(`${n + 1}. ${o}`, 256), value: truncate(who.join(' ') || 'Nobody', 1024) });
        }
        return respond(i, { embeds: [e] });
      }

      const idx = Number(rawIdx);
      if (p.ended || p.ends_at <= Date.now()) return fail(i, 'This poll has ended.');
      if (!(idx >= 0 && idx < options.length)) return;
      const mine = all<{ option_index: number }>(db, 'select option_index from polls_votes where poll_id = ? and user_id = ?', p.id, i.user.id).map((r) => r.option_index);
      if (mine.includes(idx)) run(db, 'delete from polls_votes where poll_id = ? and user_id = ? and option_index = ?', p.id, i.user.id, idx);
      else {
        if (!p.multi) run(db, 'delete from polls_votes where poll_id = ? and user_id = ?', p.id, i.user.id);
        run(db, 'insert into polls_votes (poll_id, user_id, option_index, voted_at) values (?, ?, ?, ?)', p.id, i.user.id, idx, Date.now());
      }
      throttledEdit(`poll:${p.id}`, () => refresh(ctx, p.id));

      const now = all<{ option_index: number }>(db, 'select option_index from polls_votes where poll_id = ? and user_id = ? order by option_index', p.id, i.user.id);
      const picked = now.map((r) => `**${truncate(options[r.option_index], 100)}**`);
      return respond(i, { embeds: [embed(colors.success).setDescription(picked.length ? `Your vote: ${picked.join(', ')}` : 'Your vote was removed.')] });
    },
  },
  async tick(ctx) {
    const due = all<{ id: number }>(ctx.db, 'select id from polls_list where ended = 0 and ends_at <= ?', Date.now());
    for (const { id } of due) await closePoll(ctx, id);
  },
};
