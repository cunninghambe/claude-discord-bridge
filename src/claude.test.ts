import { describe, expect, it } from 'vitest';
import { parseClaudeResult } from './claude.js';

describe('parseClaudeResult', () => {
  it('returns ok for well-formed JSON output', () => {
    const r = parseClaudeResult({
      stdout: JSON.stringify({ result: 'hello', session_id: 'sess-1' }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 100,
    });
    expect(r).toEqual({ ok: true, output: 'hello', sessionId: 'sess-1' });
  });

  it('returns timeout regardless of exit code', () => {
    const r = parseClaudeResult({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: true,
      elapsedMs: 180_000,
    });
    expect(r).toEqual({ ok: false, kind: 'timeout', elapsedMs: 180_000 });
  });

  it('detects auth failure from stderr', () => {
    const r = parseClaudeResult({
      stdout: '',
      stderr: 'Error: 401 Unauthorized — token invalid',
      exitCode: 1,
      timedOut: false,
      elapsedMs: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('auth_dead');
      if (r.kind === 'auth_dead') expect(r.detail).toMatch(/401/);
    }
  });

  it('detects auth failure from JSON error body even with zero exit', () => {
    const r = parseClaudeResult({
      stdout: JSON.stringify({ is_error: true, error: 'OAuth token expired' }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 20,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('auth_dead');
  });

  it('returns process_error for non-zero exit with non-auth stderr', () => {
    const r = parseClaudeResult({
      stdout: '',
      stderr: 'something exploded',
      exitCode: 2,
      timedOut: false,
      elapsedMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('process_error');
      if (r.kind === 'process_error') {
        expect(r.exitCode).toBe(2);
        expect(r.detail).toContain('something exploded');
      }
    }
  });

  it('returns process_error for malformed JSON with zero exit', () => {
    const r = parseClaudeResult({
      stdout: 'totally not json',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === 'process_error') {
      expect(r.detail).toMatch(/Unexpected output/);
    }
  });

  it('returns process_error when JSON is valid but shape is wrong', () => {
    const r = parseClaudeResult({
      stdout: JSON.stringify({ hello: 'world' }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('process_error');
  });

  it('flags is_error: true in otherwise-valid result as process_error', () => {
    const r = parseClaudeResult({
      stdout: JSON.stringify({
        result: 'something went wrong internally',
        session_id: 'sess-x',
        is_error: true,
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('process_error');
  });

  it('does NOT flag auth_dead when successful reply mentions oauth', () => {
    const r = parseClaudeResult({
      stdout: JSON.stringify({
        result: 'Your oauth token looks fine — 401 errors were a false positive.',
        session_id: 'sess-y',
        is_error: false,
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
      elapsedMs: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessionId).toBe('sess-y');
  });
});
