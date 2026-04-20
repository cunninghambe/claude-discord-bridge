import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AttachmentInput = {
  id: string;
  url: string;
  name: string;
  contentType: string | null;
  size: number;
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
  dir: string;
  files: DownloadedFile[];
};

export type DownloadOptions = {
  messageId: string;
  attachments: AttachmentInput[];
  baseDir?: string;
  maxBytesPerFile?: number;
  maxBytesTotal?: number;
  fetchImpl?: typeof fetch;
  perFileTimeoutMs?: number;
};

const DEFAULT_BASE_DIR = '/root/claude-bridge-data/attachments';
const DEFAULT_MAX_PER_FILE = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 100 * 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 30_000;
const SAFE_CHAR_RE = /[^A-Za-z0-9._-]/g;
const MAX_FILENAME_LEN = 128;

export function sanitizeFilename(name: string): string {
  const base = path.basename(name ?? '');
  const cleaned = base.replace(SAFE_CHAR_RE, '_').replace(/^_+/, '');
  const truncated = cleaned.slice(0, MAX_FILENAME_LEN);
  return truncated.length > 0 ? truncated : 'attachment';
}

function uniquifyFilename(used: Set<string>, id: string, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const candidate = `${stem}-${id}${ext}`.slice(0, MAX_FILENAME_LEN);
  used.add(candidate);
  return candidate;
}

export async function downloadAttachments(opts: DownloadOptions): Promise<DownloadResult> {
  const {
    messageId,
    attachments,
    baseDir = DEFAULT_BASE_DIR,
    maxBytesPerFile = DEFAULT_MAX_PER_FILE,
    maxBytesTotal = DEFAULT_MAX_TOTAL,
    fetchImpl = fetch,
    perFileTimeoutMs = DEFAULT_FILE_TIMEOUT_MS,
  } = opts;

  if (attachments.length === 0) {
    return { dir: '', files: [] };
  }

  const dir = path.join(baseDir, messageId);
  await mkdir(dir, { recursive: true });

  const used = new Set<string>();
  const files: DownloadedFile[] = [];
  let runningTotal = 0;

  for (const att of attachments) {
    if (att.size > maxBytesPerFile) {
      files.push({
        ok: false,
        originalName: att.name,
        reason: `exceeded per-file limit of ${maxBytesPerFile} bytes`,
      });
      continue;
    }
    if (runningTotal + att.size > maxBytesTotal) {
      files.push({
        ok: false,
        originalName: att.name,
        reason: 'message attachment budget exceeded',
      });
      continue;
    }

    const sanitized = sanitizeFilename(att.name);
    const local = uniquifyFilename(used, att.id, sanitized);
    const localPath = path.join(dir, local);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), perFileTimeoutMs);
    try {
      const res = await fetchImpl(att.url, { signal: controller.signal });
      if (!res.ok) {
        files.push({
          ok: false,
          originalName: att.name,
          reason: `download failed: HTTP ${res.status}`,
        });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytesPerFile) {
        files.push({
          ok: false,
          originalName: att.name,
          reason: `exceeded per-file limit of ${maxBytesPerFile} bytes`,
        });
        continue;
      }
      await writeFile(localPath, buf);
      runningTotal += buf.length;
      files.push({
        ok: true,
        originalName: att.name,
        localPath,
        contentType: att.contentType,
        size: buf.length,
      });
    } catch (err) {
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
      files.push({
        ok: false,
        originalName: att.name,
        reason: aborted
          ? `download timed out after ${perFileTimeoutMs / 1000}s`
          : `download failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      clearTimeout(t);
    }
  }

  return { dir, files };
}

export function formatManifest(result: DownloadResult): string {
  if (result.files.length === 0) return '';
  const lines = ['[attachments from discord message]'];
  for (const f of result.files) {
    if (f.ok) {
      const ct = f.contentType ?? 'application/octet-stream';
      lines.push(`- ${f.localPath} (${ct}, ${f.size} bytes)`);
    } else {
      lines.push(`- ${f.originalName}: FAILED — ${f.reason}`);
    }
  }
  return lines.join('\n') + '\n\n';
}

export async function cleanupAttachments(dir: string): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}

export async function sweepOldAttachments(
  baseDir: string,
  maxAgeMs: number,
): Promise<{ removedDirs: string[]; kept: number }> {
  const removedDirs: string[] = [];
  let kept = 0;
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return { removedDirs, kept };
  }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(baseDir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const age = now - st.mtimeMs;
    if (age > maxAgeMs) {
      try {
        await rm(full, { recursive: true, force: true });
        removedDirs.push(full);
      } catch {
        // swallow; best-effort sweep
      }
    } else {
      kept += 1;
    }
  }
  return { removedDirs, kept };
}
