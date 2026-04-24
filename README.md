# claude-discord-bridge

A single-owner Discord bot that relays DMs to a persistent [Claude Code](https://claude.com/claude-code) session on a headless server, and DMs back the login URL when the OAuth token dies. Built because Claude Code silently drops auth every few hours and re-auth needs a browser — inconvenient when the server is remote.

## What it does

- **Forwards Discord DMs** to `claude -p --resume <sessionId>` and returns Claude's output. Session persists across bot restarts via SQLite.
- **Watchdog thread** periodically probes Claude's auth. When it dies, the bot captures the login URL and DMs recovery instructions.
- **Owner-only.** One Discord user ID, one Claude session, no shared channels.
- **Attachment forwarding.** Files attached to a DM are downloaded to `/root/claude-bridge-data/attachments/<messageId>/`, and a manifest with local paths is prepended to the prompt — Claude can `Read` them directly.
- **Pre-allowed tool surface.** Spawned `claude -p` children run with `--permission-mode default --allowed-tools "Bash Edit Write Read Grep Glob ToolSearch WebFetch WebSearch TodoWrite mcp__spoonworks__* mcp__paperclip__*"` so the async Discord context doesn't stall on permission prompts.
- **Long timeout.** Default 6-hour per-turn budget to accommodate multi-step agentic work. Override with `CLAUDE_TIMEOUT_MS`.

## Stack

Node 20+ · TypeScript strict · `discord.js` v14 · `better-sqlite3` · `pino` · `zod` · `pm2`.

## Quick start

```bash
git clone https://github.com/cunninghambe/claude-discord-bridge
cd claude-discord-bridge
npm ci
cp .env.example .env   # fill in the values below
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Discord bot token (Developer Portal → Bot → Reset Token) |
| `OWNER_DISCORD_ID` | yes | 17–20 digit snowflake of the single allowed Discord user |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | Run `claude setup-token` on any device with a browser; paste the 1-year token |
| `CLAUDE_BIN` | no | Path to `claude` CLI (default `/root/.local/bin/claude`) |
| `CLAUDE_TIMEOUT_MS` | no | Per-turn hard kill (default 21,600,000 = 6h) |
| `POLL_INTERVAL_MS` | no | Watchdog probe cadence (default 600,000 = 10 min) |
| `AUTH_ALERT_DEDUPE_MS` | no | Minimum interval between duplicate auth-dead DMs (default 300,000 = 5 min) |
| `SESSIONS_DB_PATH` | no | SQLite file path (default `./data/sessions.db`) |
| `MAX_QUEUE_DEPTH_PER_USER` | no | Concurrent message cap per user (default 3) |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` (default `info`) |

Discord bot needs `GUILDS`, `DIRECT_MESSAGES`, `MESSAGE_CONTENT` intents. DM the bot once from the owner account to seed a DM channel.

## Scripts

```
npm run dev         # tsx watch, hot reload
npm run build       # tsc → dist/
npm run start       # node dist/index.js
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run test:watch  # vitest
```

## How it works

```
Discord DM ──▶ bot.ts (owner check, queue)
                │
                ▼
         attachments.ts (download → /root/claude-bridge-data/…)
                │
                ▼
         claude.ts (spawn: claude -p --output-format=json \
                           --permission-mode default \
                           --allowed-tools "…" \
                           --resume <sessionId> <prompt>)
                │
                ▼
         chunking.ts (split output at 2000 chars, upload long blobs as files)
                │
                ▼
         Discord reply
```

Sessions are persisted in SQLite keyed by Discord user ID. On bot restart, the next DM resumes the existing Claude session. `/reset` or `/new` in a DM clears it.

The watchdog is a separate timer (`watchdog.ts`) that periodically pings Claude with a trivial prompt. On failure, it inspects the error for auth-signal keywords, captures any `https://…` URL from the output, and DMs the owner recovery steps.

## Specs

Each subsystem has a spec file describing the design decisions and tradeoffs. Read these before making changes:

- [`SPEC.md`](SPEC.md) — v0.1, baseline bot + watchdog
- [`SPEC_ATTACHMENTS.md`](SPEC_ATTACHMENTS.md) — Discord file download + prompt manifest injection
- [`SPEC_ATTACHMENTS_V2.md`](SPEC_ATTACHMENTS_V2.md) — persistent attachment storage + startup sweeper (supersedes v1 cleanup behavior)
- [`SPEC_PERMISSIONS.md`](SPEC_PERMISSIONS.md) — pre-allowed tool list + timeout bump rationale

## Operations

Pm2 manages the process. `ecosystem.config.cjs` points at `dist/index.js`. Logs: `pm2 logs claude-discord-bridge`. Restart with `pm2 restart claude-discord-bridge --update-env` after changing `.env`.

Attachment dir (`/root/claude-bridge-data/attachments/`) is swept on bot startup — directories older than 30 days are deleted. Per-message dirs persist otherwise, so multi-turn workflows can reference earlier attachments.

## License

Private / unlicensed. This is a single-user tool.
