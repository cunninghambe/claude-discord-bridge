import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from './log.js';

export type ClaudeResult =
  | { ok: true; output: string; sessionId: string }
  | { ok: false; kind: 'auth_dead'; detail: string }
  | { ok: false; kind: 'timeout'; elapsedMs: number }
  | { ok: false; kind: 'process_error'; exitCode: number | null; detail: string };

export type RunClaudeOptions = {
  prompt: string;
  sessionId: string | null;
  timeoutMs: number;
  claudeBin: string;
  oauthToken: string;
  logger?: Logger;
};

const AUTH_SIGNALS =
  /oauth|unauthori[sz]ed|authentication|401|403|invalid.*(?:token|api[_ -]?key|credential)/i;

type ParseArgs = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
};

export function parseClaudeResult(args: ParseArgs): ClaudeResult {
  const { stdout, stderr, exitCode, timedOut, elapsedMs } = args;
  if (timedOut) return { ok: false, kind: 'timeout', elapsedMs };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // non-JSON output; handled below
  }

  const parsedStr =
    parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : '';

  const looksLikeAuth =
    AUTH_SIGNALS.test(stderr) ||
    AUTH_SIGNALS.test(parsedStr) ||
    exitCode === 401;

  if (looksLikeAuth) {
    const detail = (stderr || parsedStr || stdout).slice(0, 300);
    return { ok: false, kind: 'auth_dead', detail };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      kind: 'process_error',
      exitCode,
      detail: (stderr || stdout).slice(0, 500),
    };
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'result' in parsed &&
    'session_id' in parsed &&
    typeof (parsed as { result: unknown }).result === 'string' &&
    typeof (parsed as { session_id: unknown }).session_id === 'string'
  ) {
    const p = parsed as { result: string; session_id: string; is_error?: boolean };
    if (p.is_error === true) {
      return {
        ok: false,
        kind: 'process_error',
        exitCode,
        detail: p.result.slice(0, 500),
      };
    }
    return { ok: true, output: p.result, sessionId: p.session_id };
  }

  return {
    ok: false,
    kind: 'process_error',
    exitCode,
    detail: 'Unexpected output shape: ' + stdout.slice(0, 300),
  };
}

export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const args: string[] = ['-p', '--output-format=json'];
  if (opts.sessionId) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--session-id', randomUUID());
  }
  args.push(opts.prompt);

  opts.logger?.debug({ resume: Boolean(opts.sessionId) }, 'spawning claude');
  const start = Date.now();

  return new Promise<ClaudeResult>((resolve) => {
    const child = spawn(opts.claudeBin, args, {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: opts.oauthToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    const hardKill = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, opts.timeoutMs + 5000);

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      clearTimeout(hardKill);
      const elapsedMs = Date.now() - start;
      resolve(parseClaudeResult({ stdout, stderr, exitCode, timedOut, elapsedMs }));
    };

    child.on('close', (code) => settle(code));
    child.on('error', (err) => {
      stderr += '\n' + err.message;
      settle(null);
    });
  });
}
