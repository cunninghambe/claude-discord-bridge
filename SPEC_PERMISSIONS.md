# claude-discord-bridge — tool permission spec

**Status:** Draft · **Supersedes:** nothing (new) · **Scope:** `src/claude.ts`

## Problem Statement

Spawned `claude -p` children inherit user-level permission settings and prompt on every sensitive tool call (sensitive file edits, unregistered MCP tools, new file paths). The spawned process has no stdin attached for answering, so prompts silently stall the turn until the soft-kill timeout fires and the Discord user sees a timeout. The bridge is owner-only DMs, so the interactive-approval model adds no safety and only degrades UX.

## Boundaries

**In scope**
- Pass explicit permission flags to every `claude -p` spawn in `runClaude()` so the child does not block on approval prompts for the expected tool surface.
- Define the allowlist in one place in `src/claude.ts`.

**Out of scope**
- Per-message dynamic policy (e.g. different allowlists per Discord command). Single global allowlist only.
- Changes to the watchdog spawn (that's a separate `claude -p` that already runs a fixed probe).
- Changes to user-level `~/.claude/settings.json`. This spec affects only the children spawned by the bridge.
- Credential rotation. Existing `CLAUDE_CODE_OAUTH_TOKEN` and `.env` values are preserved across rebuild/restart.

**External dependencies**
- `claude` CLI flags: `--permission-mode`, `--allowed-tools` (verified via `claude --help`).

## Architecture Decision

**Decision: permission-mode `default` + explicit `--allowed-tools` allowlist.**

| Option | Verdict | Reason |
|---|---|---|
| A. `--dangerously-skip-permissions` / `--permission-mode bypassPermissions` | Rejected | Blast radius is full host even though owner-only reduces attacker surface. Defense in depth: a confused/malicious prompt should not be able to `rm -rf /` in a single turn |
| **B. `default` + allowlist (chosen)** | **Chosen** | Pre-approves the exact tool surface the bridge uses today; anything new still stalls-then-times-out, surfacing the gap rather than silently executing |
| C. `acceptEdits` mode | Rejected | Auto-approves edits but still prompts on Bash — which is the most common tool, so prompts still stall |

### Allowlist contents

Based on observed tool usage in current bridge sessions:

```
Bash Edit Write Read Grep Glob ToolSearch WebFetch WebSearch TodoWrite mcp__spoonworks__* mcp__paperclip__*
```

- Built-ins: standard read/write/search set
- `ToolSearch`: required for loading deferred MCP tool schemas on demand
- `WebFetch` / `WebSearch`: already used for external research
- `TodoWrite`: task tracking
- `mcp__spoonworks__*`: the just-registered Spoonworks MCP (47 tools)
- `mcp__paperclip__*`: existing Paperclip MCP

Deliberately **excluded** (would still prompt, effectively denied in Discord context):
- `NotebookEdit` — not used
- Any future tools — force review before allowlisting

## Interface Contract

```ts
// src/claude.ts — runClaude()
const ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'mcp__spoonworks__*',
  'mcp__paperclip__*',
].join(' ');

const args: string[] = [
  '-p',
  '--output-format=json',
  '--permission-mode', 'default',
  '--allowed-tools', ALLOWED_TOOLS,
  // existing: --resume | --session-id, then prompt
];
```

No other function signatures change. `ClaudeResult`, `RunClaudeOptions`, `parseClaudeResult()` are unchanged.

## Edge Cases

1. **Tool not in allowlist** — child prompts internally, stdin is `'ignore'`, so the call stalls until the outer `timeoutMs` fires. Surfaces as `{ ok: false, kind: 'timeout' }` to the Discord user, which correctly signals "that needed approval you can't give."
2. **New MCP server registered** — its tools are under a new `mcp__<name>__*` prefix and will stall per case 1. Operator must update the allowlist in `claude.ts` and redeploy. By design; prevents silent privilege drift.
3. **Destructive Bash invocations** (`rm -rf /`, `dd`, etc.) — **will execute without prompt** under the allowlist. This is the explicit tradeoff: owner-only DMs means the owner is the only source of input, so trust is already established at the Discord layer. No additional sandboxing in this spec.
4. **Existing long-running session resumed with `--resume`** — flags apply to the resumed session the same way. No resume-specific branching needed.
5. **Watchdog probe (`src/watchdog.ts`)** — unchanged. Its probe is a fixed canned prompt; approval prompts there would never fire anyway.

## Acceptance Criteria

1. Given a Discord DM that triggers `Bash` + `Edit` + `mcp__spoonworks__products_list`, the turn completes without any permission prompts stalling the child.
2. Given a Discord DM that triggers a tool not in the allowlist (e.g. `NotebookEdit`), the turn returns `{ ok: false, kind: 'timeout' }` after `timeoutMs`, not an approval hang.
3. `npx tsc --noEmit` passes with zero errors.
4. `npx eslint . --max-warnings 0` passes with zero warnings.
5. `npx vitest run` passes.
6. `pm2 restart claude-discord-bridge` re-reads env unchanged — `CLAUDE_CODE_OAUTH_TOKEN`, Discord bot token, `OWNER_DISCORD_USER_ID` preserved.
7. `claude.test.ts` — if it asserts the exact arg list, update it to reflect the new flags and keep all existing assertions.

## Files Touched

- `src/claude.ts` — add allowlist constant, inject two flag pairs into `args`.
- `src/claude.test.ts` — extend args-shape assertions if present.
- `SPEC_PERMISSIONS.md` — this file.
