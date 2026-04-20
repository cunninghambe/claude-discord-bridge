import { access, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AttachmentInput,
  cleanupAttachments,
  downloadAttachments,
  formatManifest,
  sanitizeFilename,
  sweepOldAttachments,
} from './attachments.js';

function makeTmpBase(): string {
  return path.join(tmpdir(), `cb-att-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('sanitizeFilename', () => {
  it('strips directory components to prevent path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/absolute/path/file.txt')).toBe('file.txt');
    // Windows-style backslashes aren't separators on Linux; replaced with _.
    // Result stays inside the per-message directory regardless.
    expect(sanitizeFilename('..\\..\\win\\path.txt')).toBe('.._.._win_path.txt');
  });

  it('replaces unsafe chars with underscore', () => {
    expect(sanitizeFilename('hello world!.md')).toBe('hello_world_.md');
    expect(sanitizeFilename('naïve.png')).toBe('na_ve.png');
  });

  it('preserves safe chars including dots, dashes, underscores', () => {
    expect(sanitizeFilename('my-file_v2.backup.tar.gz')).toBe('my-file_v2.backup.tar.gz');
  });

  it('returns "attachment" for empty or fully-unsafe input', () => {
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('   ')).toBe('attachment');
    expect(sanitizeFilename('///')).toBe('attachment');
  });

  it('caps length at 128 chars', () => {
    const long = 'a'.repeat(500) + '.txt';
    const out = sanitizeFilename(long);
    expect(out.length).toBe(128);
    expect(out.startsWith('a')).toBe(true);
  });
});

describe('formatManifest', () => {
  it('returns empty string when no files', () => {
    expect(formatManifest({ dir: '', files: [] })).toBe('');
  });

  it('renders successful downloads with path, content-type, size', () => {
    const out = formatManifest({
      dir: '/tmp/claude-bridge/123',
      files: [
        {
          ok: true,
          originalName: 'design.png',
          localPath: '/tmp/claude-bridge/123/design.png',
          contentType: 'image/png',
          size: 245678,
        },
      ],
    });
    expect(out).toContain('[attachments from discord message]');
    expect(out).toContain('/tmp/claude-bridge/123/design.png');
    expect(out).toContain('(image/png, 245678 bytes)');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('falls back to application/octet-stream when content-type missing', () => {
    const out = formatManifest({
      dir: '/tmp/x',
      files: [
        {
          ok: true,
          originalName: 'blob',
          localPath: '/tmp/x/blob',
          contentType: null,
          size: 10,
        },
      ],
    });
    expect(out).toContain('(application/octet-stream, 10 bytes)');
  });

  it('renders failures with reason', () => {
    const out = formatManifest({
      dir: '/tmp/x',
      files: [
        { ok: false, originalName: 'big.zip', reason: 'exceeded per-file limit of 26214400 bytes' },
      ],
    });
    expect(out).toContain('- big.zip: FAILED — exceeded per-file limit of 26214400 bytes');
  });

  it('renders mixed success + failure in order', () => {
    const out = formatManifest({
      dir: '/tmp/x',
      files: [
        { ok: true, originalName: 'a.md', localPath: '/tmp/x/a.md', contentType: 'text/markdown', size: 5 },
        { ok: false, originalName: 'b.iso', reason: 'message attachment budget exceeded' },
      ],
    });
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('/tmp/x/a.md');
    expect(lines[2]).toContain('b.iso: FAILED');
  });
});

describe('downloadAttachments', () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = makeTmpBase();
  });
  afterEach(async () => {
    await cleanupAttachments(baseDir);
  });

  function stubFetch(
    map: Record<string, { status?: number; body?: Uint8Array; delayMs?: number; fail?: Error }>,
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const entry = map[url];
      if (!entry) throw new Error(`unexpected fetch: ${url}`);
      if (entry.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, entry.delayMs);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      if (entry.fail) throw entry.fail;
      const body = entry.body ?? new Uint8Array([1, 2, 3]);
      return new Response(body, { status: entry.status ?? 200 });
    }) as typeof fetch;
  }

  function att(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
    return {
      id: '111',
      url: 'https://cdn.discordapp.com/attachments/1/111/file.bin',
      name: 'file.bin',
      contentType: 'application/octet-stream',
      size: 3,
      ...overrides,
    };
  }

  it('returns empty result and no directory when no attachments', async () => {
    const r = await downloadAttachments({ messageId: 'm1', attachments: [], baseDir: baseDir });
    expect(r).toEqual({ dir: '', files: [] });
  });

  it('downloads a single file and writes it to disk with sanitized name', async () => {
    const body = new Uint8Array([10, 20, 30, 40]);
    const a = att({
      name: '../evil/notes.md',
      contentType: 'text/markdown',
      size: 4,
      url: 'https://cdn/one',
    });
    const r = await downloadAttachments({
      messageId: 'm2',
      attachments: [a],
      baseDir: baseDir,
      fetchImpl: stubFetch({ 'https://cdn/one': { body } }),
    });
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f.ok).toBe(true);
    if (f.ok) {
      expect(path.basename(f.localPath)).toBe('notes.md');
      expect(path.dirname(f.localPath)).toBe(path.join(baseDir, 'm2'));
      expect(f.size).toBe(4);
      const written = await readFile(f.localPath);
      expect(Array.from(written)).toEqual([10, 20, 30, 40]);
    }
  });

  it('flags per-file overage without downloading', async () => {
    const a = att({ size: 999_999_999, url: 'https://cdn/too-big' });
    const r = await downloadAttachments({
      messageId: 'm3',
      attachments: [a],
      baseDir: baseDir,
      maxBytesPerFile: 100,
      fetchImpl: stubFetch({}),
    });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].ok).toBe(false);
    if (!r.files[0].ok) {
      expect(r.files[0].reason).toMatch(/per-file limit of 100 bytes/);
    }
  });

  it('flags cumulative overage and still tries subsequent smaller files', async () => {
    const a1 = att({ id: '1', name: 'a.bin', size: 80, url: 'https://cdn/a' });
    const a2 = att({ id: '2', name: 'b.bin', size: 80, url: 'https://cdn/b' });
    const a3 = att({ id: '3', name: 'c.bin', size: 10, url: 'https://cdn/c' });
    const r = await downloadAttachments({
      messageId: 'm4',
      attachments: [a1, a2, a3],
      baseDir: baseDir,
      maxBytesTotal: 100,
      fetchImpl: stubFetch({
        'https://cdn/a': { body: new Uint8Array(80) },
        'https://cdn/c': { body: new Uint8Array(10) },
      }),
    });
    expect(r.files[0].ok).toBe(true);
    expect(r.files[1].ok).toBe(false);
    if (!r.files[1].ok) expect(r.files[1].reason).toMatch(/budget exceeded/);
    expect(r.files[2].ok).toBe(true);
  });

  it('records HTTP error reasons', async () => {
    const a = att({ url: 'https://cdn/403', size: 3 });
    const r = await downloadAttachments({
      messageId: 'm5',
      attachments: [a],
      baseDir: baseDir,
      fetchImpl: stubFetch({ 'https://cdn/403': { status: 403 } }),
    });
    expect(r.files[0].ok).toBe(false);
    if (!r.files[0].ok) expect(r.files[0].reason).toContain('HTTP 403');
  });

  it('records timeout when fetch is aborted', async () => {
    const a = att({ url: 'https://cdn/slow', size: 3 });
    const r = await downloadAttachments({
      messageId: 'm6',
      attachments: [a],
      baseDir: baseDir,
      perFileTimeoutMs: 20,
      fetchImpl: stubFetch({ 'https://cdn/slow': { delayMs: 200 } }),
    });
    expect(r.files[0].ok).toBe(false);
    if (!r.files[0].ok) expect(r.files[0].reason).toMatch(/timed out/);
  });

  it('uniquifies duplicate filenames within a message', async () => {
    const a1 = att({ id: '1', name: 'photo.jpg', url: 'https://cdn/1', size: 3 });
    const a2 = att({ id: '2', name: 'photo.jpg', url: 'https://cdn/2', size: 3 });
    const r = await downloadAttachments({
      messageId: 'm7',
      attachments: [a1, a2],
      baseDir: baseDir,
      fetchImpl: stubFetch({
        'https://cdn/1': { body: new Uint8Array([1]) },
        'https://cdn/2': { body: new Uint8Array([2]) },
      }),
    });
    expect(r.files[0].ok && r.files[1].ok).toBe(true);
    if (r.files[0].ok && r.files[1].ok) {
      expect(r.files[0].localPath).not.toBe(r.files[1].localPath);
      expect(path.basename(r.files[1].localPath)).toContain('-2');
    }
  });
});

describe('sweepOldAttachments', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = makeTmpBase();
    await mkdir(baseDir, { recursive: true });
  });
  afterEach(async () => {
    await cleanupAttachments(baseDir);
  });

  async function mkDirWithAge(name: string, ageMs: number): Promise<string> {
    const d = path.join(baseDir, name);
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'marker'), 'x');
    const when = new Date(Date.now() - ageMs);
    await utimes(d, when, when);
    return d;
  }

  it('returns empty result when base dir does not exist', async () => {
    const r = await sweepOldAttachments('/tmp/definitely-does-not-exist-xyzzy-99', 1);
    expect(r).toEqual({ removedDirs: [], kept: 0 });
  });

  it('deletes directories older than maxAgeMs', async () => {
    const old = await mkDirWithAge('old-msg', 10_000);
    const r = await sweepOldAttachments(baseDir, 1_000);
    expect(r.removedDirs).toContain(old);
    expect(r.kept).toBe(0);
    await expect(access(old)).rejects.toThrow();
  });

  it('keeps directories newer than maxAgeMs', async () => {
    const fresh = await mkDirWithAge('fresh-msg', 100);
    const r = await sweepOldAttachments(baseDir, 60_000);
    expect(r.removedDirs).not.toContain(fresh);
    expect(r.kept).toBe(1);
    await access(fresh);
  });

  it('mixes keep and delete correctly', async () => {
    const old = await mkDirWithAge('stale', 120_000);
    const fresh = await mkDirWithAge('recent', 100);
    const r = await sweepOldAttachments(baseDir, 30_000);
    expect(r.removedDirs).toContain(old);
    expect(r.removedDirs).not.toContain(fresh);
    expect(r.kept).toBe(1);
  });

  it('skips non-directory entries without deleting them', async () => {
    const strayFile = path.join(baseDir, 'stray.txt');
    await writeFile(strayFile, 'hello');
    const when = new Date(Date.now() - 1_000_000);
    await utimes(strayFile, when, when);
    const r = await sweepOldAttachments(baseDir, 1);
    expect(r.removedDirs).not.toContain(strayFile);
    await access(strayFile); // still there
  });
});

describe('cleanupAttachments', () => {
  it('removes the directory recursively', async () => {
    const base = makeTmpBase();
    const r = await downloadAttachments({
      messageId: 'cleanup-1',
      attachments: [
        {
          id: '1',
          url: 'https://cdn/x',
          name: 'x.bin',
          contentType: null,
          size: 3,
        },
      ],
      baseTmpDir: base,
      fetchImpl: (async () => new Response(new Uint8Array([9, 9, 9]))) as typeof fetch,
    });
    expect(r.dir).toBeTruthy();
    await access(r.dir); // directory exists
    await cleanupAttachments(r.dir);
    await expect(access(r.dir)).rejects.toThrow();
    await cleanupAttachments(base);
  });

  it('no-ops on empty string or missing dir', async () => {
    await cleanupAttachments('');
    await cleanupAttachments('/tmp/definitely-does-not-exist-xyzzy-12345');
  });
});
