import { spawn } from 'node:child_process';
import type { Logger } from './log.js';

export type AuthStatus =
  | { loggedIn: true; authMethod: string; subscriptionType?: string }
  | { loggedIn: false; reason: string };

export function parseAuthStatus(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): AuthStatus {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'loggedIn' in parsed) {
      const obj = parsed as Record<string, unknown>;
      if (obj.loggedIn === true) {
        const authMethod = typeof obj.authMethod === 'string' ? obj.authMethod : 'unknown';
        const subscriptionType =
          typeof obj.subscriptionType === 'string' ? obj.subscriptionType : undefined;
        return subscriptionType !== undefined
          ? { loggedIn: true, authMethod, subscriptionType }
          : { loggedIn: true, authMethod };
      }
      const reason = typeof obj.reason === 'string' ? obj.reason : 'not logged in';
      return { loggedIn: false, reason };
    }
  } catch {
    // non-JSON; fall through
  }
  const reason = stderr.trim() || `auth status failed (exit ${exitCode})`;
  return { loggedIn: false, reason: reason.slice(0, 300) };
}

const AUTH_CHECK_TIMEOUT_MS = 30_000;

export async function checkAuth(claudeBin: string, oauthToken: string): Promise<AuthStatus> {
  return new Promise<AuthStatus>((resolve) => {
    const child = spawn(claudeBin, ['auth', 'status'], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ loggedIn: false, reason: 'auth status probe timed out' });
    }, AUTH_CHECK_TIMEOUT_MS);

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(parseAuthStatus(stdout, stderr, code));
    };

    child.on('close', (code) => settle(code));
    child.on('error', (err) => {
      stderr += err.message;
      settle(null);
    });
  });
}

export type AuthEvent =
  | { kind: 'died'; reason: string }
  | { kind: 'recovered' };

export type WatchdogOptions = {
  intervalMs: number;
  claudeBin: string;
  oauthToken: string;
  onEvent: (e: AuthEvent) => void;
  logger: Logger;
};

export function startWatchdog(opts: WatchdogOptions): () => void {
  let stopped = false;
  let lastState: 'alive' | 'dead' | 'unknown' = 'unknown';

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const status = await checkAuth(opts.claudeBin, opts.oauthToken);
      const current: 'alive' | 'dead' = status.loggedIn ? 'alive' : 'dead';
      const shouldEmitDied =
        current === 'dead' && lastState !== 'dead';
      const shouldEmitRecovered =
        current === 'alive' && lastState === 'dead';

      if (shouldEmitDied) {
        opts.logger.warn({ status }, 'claude auth is dead');
        const reason = status.loggedIn ? 'unknown' : status.reason;
        opts.onEvent({ kind: 'died', reason });
      } else if (shouldEmitRecovered) {
        opts.logger.info('claude auth recovered');
        opts.onEvent({ kind: 'recovered' });
      }
      lastState = current;
    } catch (err) {
      opts.logger.error({ err }, 'watchdog tick failed');
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, opts.intervalMs);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
