# Aura (standalone)

The free, self-hosted edition of Aura. One bot, your token, your server.

It covers the stuff most servers actually need: moderation, security, welcome messages, roles, tickets, levels, giveaways, polls and suggestions. No dashboard, no database server to set up. Everything is configured with slash commands and stored in a single SQLite file.

Built by **IamZach**. Need help? Come find us in the **Astra Gaming Network (AGN)** Discord: https://discord.gg/agn

## What's in it

| Module | What it does | On by default |
| --- | --- | --- |
| Logging | Mod actions, message edits/deletes, joins/leaves, role and channel changes | yes |
| Moderation | Warn, timeout, kick, ban (incl. temp bans), purge, slowmode, case history, lookup, auto-punish at X warnings | yes |
| Automod | Invite links, links, mass mentions, bad words, spam, repeated messages, caps | yes (only invites + mass mentions active) |
| Security | Anti-raid, anti-nuke, scam link detection, lockdown | yes |
| Verification | Button + code verification with an optional minimum account age | no |
| Welcome | Welcome, leave and DM messages | yes (needs a channel) |
| Roles | Join roles and button role panels | yes |
| Tickets | Ticket panel, private channels, claim/close, transcripts | no |
| Levels | XP, level-up messages, reward roles, leaderboard | yes |
| Giveaways | Button entry, requirements, reroll | yes |
| Polls | Button polls with live results | yes |
| Suggestions | Voting, staff review, optional threads | no |

Turn things on and off per server with `/module enable` and `/module disable`.

## Setup

You'll need [Node.js](https://nodejs.org) 22.13 or newer.

### 1. Make the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, reset the token and copy it. Keep it secret.
3. Still under **Bot**, turn on **Server Members Intent** and **Message Content Intent**.
4. Copy the **Application ID** from **General Information**.

### 2. Install

```bash
git clone https://github.com/1amZach/aura-standalone.git
cd aura-standalone
npm install
npm run build
cp config.example.json config.json
```

Open `config.json` and fill in `token` and `clientId`. If you set `devGuildId` to your server's id, commands show up there instantly while you test. Leave it empty to register them everywhere (that can take up to an hour the first time).

### 3. Invite it

Swap in your application id:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot+applications.commands&permissions=1426197703894
```

Then drag Aura's role near the top of your role list. It can only manage roles and members below it.

### 4. Run it

```bash
npm start
```

Commands sync on every start, so there's no separate deploy step. In your server, run `/setup` to check permissions, then `/help` for the rest.

To keep it running in the background, use something like [pm2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start npm --name aura -- start
pm2 save
```

### Docker

```bash
AURA_TOKEN=your-token AURA_CLIENT_ID=your-app-id docker compose up -d
```

Data lives in `./data`.

## Config

`config.json`, or environment variables if you'd rather:

| config.json | env | |
| --- | --- | --- |
| `token` | `AURA_TOKEN` | bot token |
| `clientId` | `AURA_CLIENT_ID` | application id |
| `devGuildId` | `AURA_DEV_GUILD_ID` | register commands to one server only |
| `databasePath` | `AURA_DB` | defaults to `data/aura.db` |
| `ownerIds` | `AURA_OWNER_IDS` | comma separated, can manage the security trust list in any server |

## Backups and updates

Everything is in `data/aura.db`. Stop the bot and copy that file to back it up.

To update:

```bash
git pull
npm install
npm run build
```

then restart. New tables are created automatically.

## Commands

**Core:** `/help` `/setup` `/module` `/support` `/about` `/ping`

**Logging:** `/logs set|off|ignore|show`

**Moderation:** `/warn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/slowmode` `/case view|reason|pardon` `/history` `/note` `/lookup` `/modconfig`

**Automod:** `/automod show|filter|words|allow-domain|exempt`

**Security:** `/security show|config|end-raid|trust` `/lockdown start|end`

**Verification:** `/verification setup|approve|show`

**Welcome:** `/welcome channel|message|style|off|test|show`

**Roles:** `/autorole add|remove|list` `/rolepanel create|add|remove|post|list|delete`

**Tickets:** `/tickets setup|show` `/ticket close|add|remove|rename|claim`

**Levels:** `/rank` `/leaderboard` `/levels config|reward|ignore|reset` `/xp give|take|set`

**Giveaways:** `/giveaway start|end|reroll|cancel|list`

**Polls:** `/poll create|end`

**Suggestions:** `/suggest` `/suggestion setup|approve|deny|consider|implemented`

## Support

Questions, bugs, ideas: join AGN at https://discord.gg/agn or open an issue here on GitHub.

## License

MIT with an attribution clause. See [LICENSE](LICENSE).

Short version: use it, change it, host it, share it. Just keep the credits. `/about`, `/support` and the "built by IamZach" footer have to stay, and so does the AGN support link. Add your own name next to them if you like. If the credits are removed or changed, the bot won't start.

Forks should say they're based on Aura by IamZach and link back here.
