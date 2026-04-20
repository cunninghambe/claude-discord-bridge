# claude-discord-bridge — persistent attachment storage (v0.3)

**Status:** Draft · **Supersedes:** `SPEC_ATTACHMENTS.md` (§ cleanup behavior only) · **Scope:** `src/attachments.ts`, `src/bot.ts`

## Problem Statement

v0.2 attachments were scoped to a single turn: `processPrompt` called `cleanupAttachments(download.dir)` in its `finally` block, so files vanished as soon as the `runClaude` call returned. This makes multi-turn workflows impossible — when the user attaches a 700KB xlsx on turn N and asks a follow-up question on turn N+1, I can no longer read it because the file was deleted by the finally of turn N. In practice the very first real use of attachments hit exactly this bug. Attachments must persist across turns.

## Boundaries

**In scope (new / changed)**
- Relocate default attachment base directory from `/tmp/claude-bridge` (ephemeral) to `/root/claude-bridge-data/attachments` (persistent across reboots).
- Remove per-turn deletion. Files remain until either: (a) the startup sweeper removes dirs older than the TTL, or (b) the user invokes an explicit cleanup command (out of scope for this spec).
- Add `sweepOldAttachments(baseDir, maxAgeMs)` that deletes per-message directories whose mtime is older than `maxAgeMs`. Call it once on bot startup.
- Rename the `baseTmpDir` option to `baseDir` throughout, since it is no longer a tmpfs path.

**Out of scope**
- A user-facing `/cleanup` command. The startup sweep + the persistent default are sufficient for v0.3.
- Session-scoped cleanup on `/reset` or `/new` (they currently clear Claude session; leaving attachments untouched is fine and arguably helpful).
- Background/periodic sweeping during bot uptime. Startup-only covers a restarting bot; long uptimes with heavy attachment traffic would need a timer — deferred until observed necessary.
- Quota enforcement on total disk usage.
- Moving existing v0.2 files from `/tmp/claude-bridge` to the new path (those were meant to be ephemeral; leave them to be cleared on next reboot).

**External dependencies**
- `node:fs/promises` `readdir`, `stat`, `rm`.
- No new npm dependencies.

## Architecture Decision

**Decision: keep the module boundary (`src/attachments.ts`), change default location + startup sweep hook, remove per-turn cleanup.**

**Rejected alternatives:**
- Keep cleanup in `finally` with a TTL marker file: adds complexity without buying anything — just removing the cleanup is simpler.
- Cron job / systemd timer: works but adds infrastructure concerns unrelated to the bridge itself; a one-shot sweep on bot startup is adequate because pm2 restarts are how we deploy anyway.
- Per-user subdirectories (`<base>/<userId>/<messageId>/…`): the bridge is single-owner. Extra structure with no payoff.

## Interface Contract

```ts
// src/attachments.ts

export type DownloadOptions = {
  messageId: string;
  attachments: AttachmentInput[];
  baseDir?: string;               // default: '/root/claude-bridge-data/attachments'
  maxBytesPerFile?: number;       // unchanged: 25 MB
  maxBytesTotal?: number;         // unchanged: 100 MB
  fetchImpl?: typeof fetch;
  perFileTimeoutMs?: number;      // unchanged: 30s
};

export async function downloadAttachments(opts: DownloadOptions): Promise<DownloadResult>;
export function formatManifest(result: DownloadResult): string;
export async function cleanupAttachments(dir: string): Promise<void>;  // retained for tests / future /cleanup
export function sanitizeFilename(name: string): string;

/** New. Removes per-message directories older than maxAgeMs. */
export async function sweepOldAttachments(
  baseDir: string,
  maxAgeMs: number,
): Promise<{ removedDirs: string[]; kept: number }>;
```

```ts
// src/bot.ts — changes
// 1. remove `await cleanupAttachments(download.dir).catch(...)` from the finally block of processPrompt
// 2. on bot.start(), call sweepOldAttachments(baseDir, THIRTY_DAYS_MS) and log the result
```

TTL: **30 days** (2_592_000_000 ms). Rationale: long enough to cover any realistic multi-session workflow; short enough that truly-forgotten files eventually clear.

## Edge Cases

1. **Base dir does not exist at startup** — `sweepOldAttachments` no-ops (nothing to sweep). `downloadAttachments` already creates it via `mkdir({ recursive: true })`.
2. **Non-directory entries in base dir** (e.g. someone drops a file in `/root/claude-bridge-data/attachments/garbage.txt`) — `sweepOldAttachments` skips non-directory entries. Does not delete unexpected files.
3. **mtime in the future** (clock skew / restored backup) — age is `Date.now() - stat.mtimeMs`; negative ages never exceed the TTL; entry is kept. Safe.
4. **Permission error on sweep** — log a warning, do not crash the bot. Swallowed.
5. **Concurrent download during sweep** — unlikely in practice (sweep is startup-only, downloads happen later per message), but `rm` ignores in-use files on Linux; worst case the download fails and gets recorded as a `DownloadedFile` failure.
6. **Bot restarts mid-turn** — attachments from the interrupted turn persist; next turn on that message retries from scratch (Discord would have already given up anyway).
7. **Disk full** — `mkdir` / `writeFile` error propagates from `downloadAttachments` as a `DownloadedFile` failure. Not this spec's problem to resolve.

## Acceptance Criteria

1. After a turn completes, the per-message directory **still exists on disk**, unlike v0.2. Inspected by listing `/root/claude-bridge-data/attachments/<messageId>/`.
2. `sweepOldAttachments` removes a directory whose mtime is older than `maxAgeMs` and keeps one that is newer. Covered by unit tests that manipulate mtime directly via `utimes`.
3. `downloadAttachments` uses the new `baseDir` option name; TypeScript compile fails on any remaining `baseTmpDir` reference (caught by `tsc --noEmit`).
4. Bot startup logs a line like `swept N old attachment dirs, kept M`.
5. `npx tsc --noEmit` passes with zero errors.
6. `npx vitest run` passes. `src/attachments.test.ts` updated: every test using `baseTmpDir` switched to `baseDir`, plus new tests for `sweepOldAttachments` (keep-recent, delete-old, ignore-non-dir, empty base dir).
7. `npm run build` succeeds.
8. `pm2 restart claude-discord-bridge --update-env` leaves env unchanged.

## Files Touched

- `src/attachments.ts` — change default, rename `baseTmpDir` → `baseDir`, add `sweepOldAttachments`.
- `src/attachments.test.ts` — rename + new sweeper tests.
- `src/bot.ts` — remove `cleanupAttachments` call from `finally`; add startup sweep.
- `SPEC_ATTACHMENTS_V2.md` — this file.

No changes to `src/claude.ts`, `src/config.ts`, `src/sessions.ts`, `src/watchdog.ts`, `.env`, or `ecosystem.config.cjs`.
