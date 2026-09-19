import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeInbox {
  path: string;
  lines: unknown[];
  /** Reply frames the server writes back after the first message frame. */
  replyWith: string[];
  close(): Promise<void>;
}

/** A stand-in for a Claude Code session's UDS inbox. */
export async function fakeInbox(opts: { accept?: boolean } = {}): Promise<FakeInbox> {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-sock-'));
  const path = join(dir, 'inbox.sock');
  const lines: unknown[] = [];
  const replyWith: string[] = [];

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === '') continue;
        try {
          lines.push(JSON.parse(line));
        } catch {
          lines.push({ unparseable: line });
        }
        for (const r of replyWith.splice(0)) conn.write(r + '\n');
      }
    });
    conn.on('error', () => {});
  });

  if (opts.accept !== false) {
    await new Promise<void>((res) => server.listen(path, res));
  }

  return {
    path,
    lines,
    replyWith,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}
