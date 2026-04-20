# claude-discord-bridge — Discord attachment forwarding

**Status:** Draft · **Supersedes:** nothing (new) · **Scope:** `src/bot.ts`, new `src/attachments.ts`

## Problem Statement

Discord users (owner) routinely attach images, screenshots, logs, and documents to DMs to give context for a task. The v0.1 bridge only forwards `msg.content` — every attachment is silently dropped before reaching the spawned `claude -p` child, so attachments might as well not have been sent. This forces the user to paste content inline, SCP files onto the server, or describe attachments verbally. This spec adds automatic attachment download and path injection: any file attached to a Discord DM is downloaded to a per-message temp directory, and a manifest listing local paths is prepended to the prompt Claude receives.

## Boundaries

**In scope**
- Download `msg.attachments` from Discord's CDN into a per-message directory (`/tmp/claude-bridge/<messageId>/<sanitized-filename>`).
- Prepend a plain-text manifest (local paths + content type + size) to the prompt string passed to `runClaude`.
- Enforce per-file and per-message size caps to prevent disk fill.
- Sanitize filenames to prevent path traversal.
- Clean up the per-message directory after the turn completes (success, failure, or timeout — always).

**Out of scope**
- Streaming large files or resumable downloads.
- Content extraction (OCR, PDF text, image vision). Claude's own `Read` tool handles file contents; this spec only puts files on disk and tells the agent where.
- Persisting attachments beyond a single turn.
- Re-uploading output attachments — that direction (Claude → Discord) is already handled in `sendChunked` via `AttachmentBuilder`.
- Attachment forwarding for the watchdog's canned probe (no attachments there).

**External dependencies**
- `fetch` (Node 18+ global). No new npm dependency.
- `node:fs/promises` for file writes and cleanup.
- `node:path` for sanitization.
- `node:os.tmpdir()` → parameterized default (`/tmp/claude-bridge`).

## Architecture Decision

**Decision: new isolated module `src/attachments.ts`**. `bot.ts` stays focused on Discord-layer logic; download + manifest + cleanup is a testable unit.

Injection point in `processPrompt` (currently `src/bot.ts:104`): wrap the existing `runClaude` call in a download-prep step and a `finally` cleanup step. No changes to `claude.ts`.

**Rejected alternatives:**
- Put download logic inline in `bot.ts`: couples Discord handling with filesystem concerns, hurts testability.
- Put download logic in `claude.ts`: `claude.ts` doesn't know about Discord; adding `attachments[]` to `RunClaudeOptions` would leak the concept into the wrong layer.
- Stream directly to stdin of `claude -p`: the CLI doesn't accept attachments that way; it reads files via its `Read` tool at paths mentioned in the prompt.

## Interface Contract

```ts
// src/attachments.ts

/** Discord-provided attachment info (subset of discord.js Attachment). */
export type AttachmentInput = {
  id: string;               // Discord attachment id, used for per-file naming collisions
  url: string;              // Discord CDN url (signed, public read)
  name: string;             // original filename as uploaded
  contentType: string | null;
  size: number;             // bytes, as reported by Discord
};

export type DownloadedFile =
  | {
      ok: true;
      originalName: string;
      localPath: string;
      contentType: string | null;
      size: number;
    }
  | {
      ok: false;
      originalName: string;
      reason: string;
    };

export type DownloadResult = {
  dir: string;                    // the per-message directory created (or '' if no attachments)
  files: DownloadedFile[];
};

export type DownloadOptions = {
  messageId: string;
  attachments: AttachmentInput[];
  baseTmpDir?: string;            // default: '/tmp/claude-bridge'
  maxBytesPerFile?: number;       // default: 25 * 1024 * 1024 (25MB, matches Discord free-tier cap)
  maxBytesTotal?: number;         // default: 100 * 1024 * 1024 (100MB per message)
  fetchImpl?: typeof fetch;       // injected for tests
};

export async function downloadAttachments(opts: DownloadOptions): Promise<DownloadResult>;

export function formatManifest(result: DownloadResult): string;
  // Returns '' when result.files is empty. Otherwise returns a block like:
  //   [attachments from discord message]
  //   - /tmp/claude-bridge/<id>/design.png (image/png, 245678 bytes)
  //   - notes.md: FAILED — exceeded 25MB limit
  //
  // Always ends with a single trailing newline when non-empty.

export async function cleanupAttachments(dir: string): Promise<void>;
  // rm -rf equivalent. No-op if dir is empty string or does not exist.

export function sanitizeFilename(name: string): string;
  // Strips path components; replaces anything outside [A-Za-z0-9._-] with '_';
  // caps length at 128 chars; returns 'attachment' if input is empty after stripping.
```

## Edge Cases

1. **No attachments** — `formatManifest` returns `''`; prompt passed to `runClaude` is unchanged from v0.1 behavior.
2. **Path traversal in filename** (`../../etc/passwd`) — `sanitizeFilename` uses `path.basename()` + allowlist regex. Result is safe (`passwd`) and stays inside the per-message directory.
3. **Duplicate filenames** — the Discord attachment `id` is prepended with a hyphen to the sanitized filename only on collision within a single message. First file keeps its clean name.
4. **File over `maxBytesPerFile`** — recorded as `{ ok: false, reason: 'exceeded per-file limit of X bytes' }`. Not downloaded. Other files in same message still attempt download.
5. **Cumulative files over `maxBytesTotal`** — once the running total would be exceeded, remaining attachments short-circuit to `{ ok: false, reason: 'message attachment budget exceeded' }`.
6. **HTTP 4xx/5xx from Discord CDN** (e.g. signed URL expired) — `{ ok: false, reason: 'download failed: HTTP 403' }`. Partial writes (if any) are cleaned up along with the directory.
7. **Network timeout** — `fetch` has no built-in timeout; we impose a 30s per-file soft timeout via `AbortController`. On abort, record `{ ok: false, reason: 'download timed out after 30s' }`.
8. **Empty filename after sanitization** — falls back to `'attachment'` (still uniquified by id prefix on collision).
9. **Process crash before cleanup** — `/tmp/claude-bridge/*` accumulates. Acceptable: `/tmp` is cleared on reboot on this host. A sweeper is out of scope for v0.2.
10. **Cleanup fires on timeout path in `runClaude`** — `processPrompt`'s `finally` block runs regardless of `runClaude` outcome, so cleanup is guaranteed.
11. **Manifest length** — does not count toward Claude's prompt budget practically (one line per file, bounded by Discord's 10-attachments-per-message limit).
12. **Binary vs text content** — identical handling. Claude's own `Read` tool knows the difference.

## Acceptance Criteria

1. Given a DM with one 240KB PNG attachment, `runClaude` is invoked with a prompt that begins:
   ```
   [attachments from discord message]
   - /tmp/claude-bridge/<messageId>/<sanitizedName>.png (image/png, 245678 bytes)

   <msg.content>
   ```
   and the PNG exists at that path at the time `runClaude` is called.

2. Given a DM with one 30MB file (exceeds 25MB per-file limit), the manifest shows
   `- bigfile.zip: FAILED — exceeded per-file limit of 26214400 bytes`
   and no file is written for it.

3. Given a DM with no attachments, the prompt passed to `runClaude` is exactly `msg.content`, byte-identical to v0.1.

4. After `runClaude` returns — successfully, on timeout, or on error — `/tmp/claude-bridge/<messageId>` no longer exists.

5. Given an attachment named `../../etc/passwd`, it is written to `/tmp/claude-bridge/<messageId>/etc_passwd` (not outside the message directory).

6. `npx tsc --noEmit` passes with zero errors.
7. `npx vitest run` passes. New test file `src/attachments.test.ts` covers: sanitization (path traversal, unicode, empty, too-long), manifest formatting (empty, all-success, mixed success/fail), and `downloadAttachments` with injected fetch stub (success, per-file overage, total overage, HTTP error, timeout).
8. `pm2 restart claude-discord-bridge --update-env` re-reads env unchanged; credentials preserved.

## Files Touched

- `src/attachments.ts` — new module.
- `src/attachments.test.ts` — new tests.
- `src/bot.ts` — wire download + manifest into `processPrompt`; add cleanup to `finally`.
- `SPEC_ATTACHMENTS.md` — this file.

No changes to `src/claude.ts`, `src/config.ts`, `src/sessions.ts`, `src/watchdog.ts`, `ecosystem.config.cjs`, `.env`, or any other file.
