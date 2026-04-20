import { describe, expect, it } from 'vitest';
import { parseAuthStatus } from './watchdog.js';

describe('parseAuthStatus', () => {
  it('parses a logged-in response with subscription', () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
    });
    expect(parseAuthStatus(stdout, '', 0)).toEqual({
      loggedIn: true,
      authMethod: 'oauth_token',
      subscriptionType: 'max',
    });
  });

  it('parses a logged-in response without subscription', () => {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
    const r = parseAuthStatus(stdout, '', 0);
    expect(r.loggedIn).toBe(true);
    if (r.loggedIn) {
      expect(r.authMethod).toBe('claude.ai');
      expect(r.subscriptionType).toBeUndefined();
    }
  });

  it('parses a logged-out response with reason', () => {
    const stdout = JSON.stringify({ loggedIn: false, reason: 'token expired' });
    expect(parseAuthStatus(stdout, '', 0)).toEqual({
      loggedIn: false,
      reason: 'token expired',
    });
  });

  it('falls back to stderr when stdout is not JSON', () => {
    const r = parseAuthStatus('garbage', 'boom: network error', 1);
    expect(r.loggedIn).toBe(false);
    if (!r.loggedIn) expect(r.reason).toMatch(/boom/);
  });

  it('falls back to exit code when neither stdout nor stderr carry a reason', () => {
    const r = parseAuthStatus('', '', 1);
    expect(r.loggedIn).toBe(false);
    if (!r.loggedIn) expect(r.reason).toMatch(/exit 1/);
  });

  it('treats missing loggedIn key as logged out', () => {
    const stdout = JSON.stringify({ somethingElse: true });
    const r = parseAuthStatus(stdout, '', 0);
    expect(r.loggedIn).toBe(false);
  });
});
