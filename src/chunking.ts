export const DISCORD_MAX = 2000;
export const ATTACHMENT_THRESHOLD = 8000;

export type Chunk =
  | { kind: 'text'; content: string }
  | { kind: 'file'; content: string; filename: string };

export function chunkForDiscord(
  content: string,
  opts: { filenameHint?: string } = {},
): Chunk[] {
  if (content.length === 0) {
    return [{ kind: 'text', content: '(empty response)' }];
  }
  if (content.length <= DISCORD_MAX) {
    return [{ kind: 'text', content }];
  }
  if (content.length > ATTACHMENT_THRESHOLD) {
    const filename = opts.filenameHint ?? `response-${Date.now()}.md`;
    return [{ kind: 'file', content, filename }];
  }
  return splitAtBoundaries(content).map((c) => ({ kind: 'text', content: c }));
}

function splitAtBoundaries(content: string): string[] {
  const result: string[] = [];
  let buf = '';

  const paragraphs = content.split(/\n\n+/);
  for (const p of paragraphs) {
    const join = buf ? '\n\n' : '';
    if ((buf + join + p).length <= DISCORD_MAX) {
      buf = buf + join + p;
      continue;
    }
    if (buf) {
      result.push(buf);
      buf = '';
    }
    if (p.length <= DISCORD_MAX) {
      buf = p;
      continue;
    }
    for (const line of p.split('\n')) {
      const ljoin = buf ? '\n' : '';
      if ((buf + ljoin + line).length <= DISCORD_MAX) {
        buf = buf + ljoin + line;
        continue;
      }
      if (buf) {
        result.push(buf);
        buf = '';
      }
      if (line.length <= DISCORD_MAX) {
        buf = line;
        continue;
      }
      let rem = line;
      while (rem.length > DISCORD_MAX) {
        result.push(rem.slice(0, DISCORD_MAX));
        rem = rem.slice(DISCORD_MAX);
      }
      buf = rem;
    }
  }
  if (buf) result.push(buf);
  return result;
}
