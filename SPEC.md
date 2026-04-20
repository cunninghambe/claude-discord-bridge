# claude-discord-bridge — v0.1 spec

## Problem Statement

Claude Code runs on a headless server and is the user's primary agent, but two failure modes cut off access. First, its OAuth auth silently dies every few hours and cannot reconnect itself — re-auth requires a browser on the server, which is impractical remotely. Second, the user has no way to reach Claude Code from their phone; the previous WhatsApp bridge is gone and WhatsApp is blocked from this datacenter IP anyway. This service provides a Discord-based channel that relays messages to a persistent `claude -p` session and, when auth dies, captures the login URL and DMs it to the owner so they can complete OAuth from their phone.

## Boundaries

**In scope**
- Discord bot (single-owner DM interface) that forwards messages to Claude Code via `claude -p ... --resume <sessionId>` and returns output.
- Auth watchdog: periodic liveness probe of `claude -p`; on failure, capture the login URL and DM the owner.
- Session persistence: Discord-user → Claude session-id, survives bot restarts.
- Output chunking for Discord's 2000-char limit.
- Owner allowlist (single Discord user ID).

**Out of scope (v0.1)**
- Multi-user or shared-channel use. DM-only, one owner.
- Voice, slash commands, embeds, reactions.
- Automating the browser step of OAuth.
- Streaming partial output as Claude thinks (send final output only).
- Tool-call approval flows (Claude Code runs with its existing config).
- WhatsApp / SMS / anything not Discord.

**External dependencies**
- `discord.js` v14 — Discord client library.
- `better-sqlite3` — session store.
- `zod` — env var validation.
- Claude Code CLI (`claude`) pre-installed on host, auth'd via OAuth initially.

## Interface Contract

```ts
// src/types.ts
type UserSession = {
  discordUserId: string;
  claudeSessionId: string | null;  // null until first successful turn
  createdAt: Date;
  lastUsedAt: Date;
};

type ClaudeResult =
  | { ok: true; output: string; sessionId: string }
  | { ok: false; kind: "auth_dead"; loginUrl: string | null }
  | { ok: false; kind: "timeout"; elapsedMs: number }
  | { ok: false; kind: "process_error"; exitCode: number; stderr: string };

type AuthStatus =
  | { alive: true }
  | { alive: false; loginUrl: string | null };

// src/claude.ts
export async function runClaude(
  prompt: string,
  sessionId: string | null,
  opts?: { timeoutMs?: number }
): Promise<ClaudeResult>;

// src/watchdog.ts
export async function checkAuth(): Promise<AuthStatus>;
export function startWatchdog(intervalMs: number, onAuthDead: (url: string | null) => void): () => void;

// src/auth-recovery.ts
export async function captureLoginUrl(): Promise<string | null>;

// src/sessions.ts
export function getSession(discordUserId: string): UserSession | null;
export function upsertSession(s: UserSession): void;
export function clearSession(discordUserId: string): void;

// src/bot.ts
export async function startBot(): Promise<void>;  // connects, registers handlers
export async function dmOwner(text: string): Promise<void>;
```

**Side effects declared**
- `runClaude`: spawns child process, reads stdout/stderr, no filesystem writes beyond what Claude itself does.
- `startBot`: opens Discord gateway connection.
- `startWatchdog`: sets interval timer.
- `sessions`: reads/writes SQLite at `./data/sessions.db`.

## Edge Cases

1. **User sends a second message while prior `claude -p` still running** — queue per-user; serialize. If queue depth > 3, reply "still working on previous, dropping new message."
2. **`claude -p` hangs past timeout** (default 180s) — kill child, reply "timed out after 3 min," keep session intact.
3. **Output > 2000 chars** — chunk on code-fence/paragraph boundaries; if still too large, send as `.md` file attachment.
4. **Auth dies mid-conversation** — `runClaude` returns `{ kind: "auth_dead" }`; bot replies "auth expired, check DMs," watchdog DMs login URL.
5. **Watchdog runs while a user request is in flight** — skip this tick; don't compete for CLI.
6. **Bot restarts** — sessions table persists; reconnect, resume. In-flight prompts at restart time are lost (user must re-send).
7. **Non-owner DMs the bot** — silently ignore (log at debug level).
8. **Login URL capture fails** (CLI output shape changed, race, whatever) — DM owner "auth is dead but I can't find the login URL, run `claude login` on the server manually."
9. **Discord gateway disconnects** — `discord.js` auto-reconnects; bot logs but does not alert unless disconnect > 5 min.
10. **Session row grows stale** (>30 days unused) — leave it; Claude Code will refuse-or-restart the session naturally.
11. **Owner sends `/reset` or `/new`** — clear their session row, next message starts fresh.
12. **`claude` binary not on PATH** — startup fails loudly with clear error.

## Acceptance Criteria

- Given the bot is running and owner DMs "hello", bot replies with Claude's response within the timeout window and persists a session row for that Discord user.
- Given a prior session exists for the owner, the second DM resumes the same Claude session (verified by asking Claude to recall the prior turn).
- Given auth is dead, `runClaude` returns `{ ok: false, kind: "auth_dead" }` and the bot replies with a short error to the user who sent the message.
- Given the watchdog detects auth death, the owner receives a DM containing the login URL (or a failure notice if capture didn't work) within one poll interval.
- Given the owner sends `/reset`, the next message from them starts a fresh Claude session (no resume).
- Given output exceeds 2000 chars, the user receives the full output across multiple messages or one attached file — never truncated silently.
- Given a non-owner DMs the bot, the bot does not reply and does not invoke `claude`.
- Type-check passes with zero errors (`tsc --noEmit`), lint passes with zero warnings, and tests pass for `sessions`, `claude` (mocked spawn), and output chunking.

## Architecture Decision

**New repo, single-process Node service.** Deployed under pm2 alongside the existing processes on this server. Systemd not needed — pm2 already runs as the supervisor.

**Layout (follows global CLAUDE.md conventions):**
```
claude-discord-bridge/
├── src/
│   ├── bot.ts           # Discord client, message handlers, owner allowlist
│   ├── claude.ts        # Child-process wrapper around `claude -p`
│   ├── watchdog.ts      # Periodic auth probe
│   ├── auth-recovery.ts # Login URL capture + DM coordination
│   ├── sessions.ts      # SQLite session store
│   ├── chunking.ts      # Discord 2000-char output splitter
│   ├── config.ts        # Zod-validated env: DISCORD_BOT_TOKEN, OWNER_DISCORD_ID, CLAUDE_BIN, POLL_INTERVAL_MS
│   ├── log.ts           # pino logger
│   └── index.ts         # wiring
├── src/**/*.test.ts     # Vitest co-located
├── data/                # gitignored; SQLite lives here
├── ecosystem.config.cjs # pm2 config
├── tsconfig.json
├── package.json
├── .env.example
└── README.md
```

**Design pattern** — plain async functions, no classes, no DI framework. State lives in two places: SQLite (sessions) and in-process per-user request queues (map).

## Spike Findings (2026-04-20)

All three open questions resolved. Findings reshape the auth strategy:

1. **`claude setup-token` creates a 1-year long-lived token** backed by the Claude subscription (not API billing). Interactive browser needed *once* on any device (owner's laptop); resulting token is set as `CLAUDE_CODE_OAUTH_TOKEN` env var on the server. **This is the primary auth mechanism.** The "auth dies every few hours" problem is an artifact of the short-lived interactive OAuth session — `setup-token` sidesteps it entirely.
2. **`claude auth status` returns structured JSON** — `{ loggedIn, authMethod, apiProvider, email, subscriptionType, ... }`. This is the watchdog's liveness probe. No stderr string parsing required.
3. **`claude -p --resume <id>` works across fully isolated processes.** Verified empirically by running one `claude -p` invocation to store a phrase, then resuming with `env -i` (stripped environment) in a separate process — the phrase was recalled correctly. Sessions persist to disk and will survive pm2/server restarts.

### Revised architecture (supersedes auth-recovery plan above)

**Primary path — long-lived token, no recovery needed.** Owner runs `claude setup-token` once on their laptop, copies the resulting token into the server's `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, pm2 picks it up. Valid for one year.

**Watchdog** — polls `claude auth status --output-format=json` (or the plain `claude auth status` which already returns JSON on this version) every ~10 min. If `loggedIn === false` OR command fails, DM the owner: *"Token expired or revoked. Run `claude setup-token` on any browser machine, then update `CLAUDE_CODE_OAUTH_TOKEN` in server env and `pm2 restart claude-discord-bridge`."* No in-band URL capture, no browser-callback dance.

**Simplified interfaces:**
```ts
type AuthStatus = { loggedIn: true; authMethod: string; subscriptionType?: string }
                | { loggedIn: false; reason?: string };

export async function checkAuth(): Promise<AuthStatus>;  // runs `claude auth status`
// auth-recovery.ts is deleted — not needed.
```

**Claude invocation** — `claude -p --session-id <uuid> --output-format=json "<prompt>"` for the first turn, `claude -p --resume <uuid> --output-format=json "<prompt>"` for subsequent turns. Session IDs generated with `crypto.randomUUID()` and stored in SQLite keyed by Discord user.

### Updated file list
Remove `src/auth-recovery.ts` from the layout. Everything else stands.
