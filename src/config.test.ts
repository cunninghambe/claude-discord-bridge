import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'x'.repeat(50),
  DISCORD_BOT_TOKEN: 'mtq' + 'a'.repeat(60),
  OWNER_DISCORD_ID: '818781580818120726',
};

describe('loadConfig', () => {
  it('loads minimum required vars with defaults', () => {
    const c = loadConfig(base as unknown as NodeJS.ProcessEnv);
    expect(c.CLAUDE_BIN).toBe('/root/.local/bin/claude');
    expect(c.POLL_INTERVAL_MS).toBe(600_000);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('coerces numeric env vars from strings', () => {
    const c = loadConfig({
      ...base,
      POLL_INTERVAL_MS: '120000',
      CLAUDE_TIMEOUT_MS: '60000',
    } as unknown as NodeJS.ProcessEnv);
    expect(c.POLL_INTERVAL_MS).toBe(120_000);
    expect(c.CLAUDE_TIMEOUT_MS).toBe(60_000);
  });

  it('rejects invalid Discord user id', () => {
    expect(() =>
      loadConfig({ ...base, OWNER_DISCORD_ID: 'not-a-snowflake' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/OWNER_DISCORD_ID/);
  });

  it('rejects missing token', () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _omit, ...without } = base;
    expect(() => loadConfig(without as unknown as NodeJS.ProcessEnv)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it('rejects bogus log level', () => {
    expect(() =>
      loadConfig({ ...base, LOG_LEVEL: 'chatty' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/LOG_LEVEL/);
  });
});
