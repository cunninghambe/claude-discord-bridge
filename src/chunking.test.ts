import { describe, expect, it } from 'vitest';
import { ATTACHMENT_THRESHOLD, DISCORD_MAX, chunkForDiscord } from './chunking.js';

describe('chunkForDiscord', () => {
  it('returns single text chunk for short content', () => {
    const chunks = chunkForDiscord('hello');
    expect(chunks).toEqual([{ kind: 'text', content: 'hello' }]);
  });

  it('returns a placeholder for empty content rather than nothing', () => {
    const chunks = chunkForDiscord('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe('text');
  });

  it('keeps content exactly at the Discord limit as a single chunk', () => {
    const content = 'x'.repeat(DISCORD_MAX);
    const chunks = chunkForDiscord(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ kind: 'text', content });
  });

  it('splits medium content across multiple text chunks under the limit', () => {
    const para = 'a'.repeat(500);
    const content = Array.from({ length: 10 }, () => para).join('\n\n');
    const chunks = chunkForDiscord(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.kind).toBe('text');
      if (c.kind === 'text') expect(c.content.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
  });

  it('prefers paragraph boundaries when splitting', () => {
    const para = 'x'.repeat(1000);
    const content = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkForDiscord(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.kind).toBe('text');
    }
  });

  it('returns a file chunk when content exceeds attachment threshold', () => {
    const content = 'y'.repeat(ATTACHMENT_THRESHOLD + 1);
    const chunks = chunkForDiscord(content, { filenameHint: 'big.md' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ kind: 'file', content, filename: 'big.md' });
  });

  it('hard-breaks single lines longer than the Discord limit', () => {
    const line = 'z'.repeat(DISCORD_MAX + 500);
    const chunks = chunkForDiscord(line + '\n\n' + 'tail');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.kind).toBe('text');
      if (c.kind === 'text') expect(c.content.length).toBeLessThanOrEqual(DISCORD_MAX);
    }
    const reassembled = chunks.map((c) => (c.kind === 'text' ? c.content : '')).join('');
    expect(reassembled.replace(/\s/g, '')).toBe((line + 'tail').replace(/\s/g, ''));
  });

  it('uses a default filename when hint not provided', () => {
    const content = 'q'.repeat(ATTACHMENT_THRESHOLD + 1);
    const chunks = chunkForDiscord(content);
    expect(chunks[0]?.kind).toBe('file');
    if (chunks[0]?.kind === 'file') {
      expect(chunks[0].filename).toMatch(/^response-\d+\.md$/);
    }
  });
});
