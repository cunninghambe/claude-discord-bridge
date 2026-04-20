import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSessionStore, type SessionStore } from './sessions.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = openSessionStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('returns null when no session for user', () => {
    expect(store.get('123')).toBeNull();
  });

  it('upsert stores and retrieves a session', () => {
    const created = new Date('2026-04-20T12:00:00Z');
    const used = new Date('2026-04-20T12:05:00Z');
    store.upsert({
      discordUserId: '123',
      claudeSessionId: 'sess-abc',
      createdAt: created,
      lastUsedAt: used,
    });
    const s = store.get('123');
    expect(s).not.toBeNull();
    expect(s?.claudeSessionId).toBe('sess-abc');
    expect(s?.createdAt.toISOString()).toBe(created.toISOString());
    expect(s?.lastUsedAt.toISOString()).toBe(used.toISOString());
  });

  it('upsert updates lastUsedAt and sessionId without changing createdAt', () => {
    const created = new Date('2026-04-20T12:00:00Z');
    store.upsert({
      discordUserId: '123',
      claudeSessionId: 'sess-1',
      createdAt: created,
      lastUsedAt: created,
    });
    const later = new Date('2026-04-20T13:00:00Z');
    store.upsert({
      discordUserId: '123',
      claudeSessionId: 'sess-2',
      createdAt: created,
      lastUsedAt: later,
    });
    const s = store.get('123');
    expect(s?.claudeSessionId).toBe('sess-2');
    expect(s?.lastUsedAt.toISOString()).toBe(later.toISOString());
    expect(s?.createdAt.toISOString()).toBe(created.toISOString());
  });

  it('supports null claudeSessionId', () => {
    store.upsert({
      discordUserId: '123',
      claudeSessionId: null,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    });
    expect(store.get('123')?.claudeSessionId).toBeNull();
  });

  it('clear removes the session', () => {
    store.upsert({
      discordUserId: '123',
      claudeSessionId: 'sess',
      createdAt: new Date(),
      lastUsedAt: new Date(),
    });
    store.clear('123');
    expect(store.get('123')).toBeNull();
  });

  it('clear of missing row is a no-op', () => {
    expect(() => store.clear('999')).not.toThrow();
  });

  it('isolates sessions across users', () => {
    const now = new Date();
    store.upsert({ discordUserId: 'a', claudeSessionId: 'sa', createdAt: now, lastUsedAt: now });
    store.upsert({ discordUserId: 'b', claudeSessionId: 'sb', createdAt: now, lastUsedAt: now });
    expect(store.get('a')?.claudeSessionId).toBe('sa');
    expect(store.get('b')?.claudeSessionId).toBe('sb');
    store.clear('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')?.claudeSessionId).toBe('sb');
  });
});
