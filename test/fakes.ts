import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
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

export interface FakeOpencodeInstance {
  path: string;
  /** Raw, unparsed lines as they arrived — for exact-wire-format assertions. */
  rawLines: string[];
  close(): Promise<void>;
}

/** A stand-in for the opencode plugin's per-instance Unix socket (SPEC.md §7). */
export async function fakeOpencodeInstance(): Promise<FakeOpencodeInstance> {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-oc-sock-'));
  const path = join(dir, 'inst-test.sock');
  const rawLines: string[] = [];

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        rawLines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    conn.on('error', () => {});
  });

  await new Promise<void>((res) => server.listen(path, res));

  return {
    path,
    rawLines,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/**
 * A stand-in for a peer that accepts a connection, reads the line, but never
 * closes its side — the case sendToInstance's fallback timer exists for.
 * Requires `allowHalfOpen: true`: the default (false) makes Node close the
 * server's side automatically the moment the client's end() is received,
 * which is exactly the behaviour this fake must not have.
 */
export async function fakeOpencodeInstanceNeverCloses(): Promise<FakeOpencodeInstance> {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-oc-hang-'));
  const path = join(dir, 'inst-hang.sock');
  const rawLines: string[] = [];

  const open = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    open.add(conn);
    conn.on('close', () => open.delete(conn));
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        rawLines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    conn.on('error', () => {});
    // Deliberately never conn.end() / conn.destroy() here.
  });

  await new Promise<void>((res) => server.listen(path, res));

  return {
    path,
    rawLines,
    close: () =>
      new Promise<void>((res) => {
        // net.Server#close() waits for every open connection to end, which
        // never happens here by design — destroy them ourselves so cleanup
        // doesn't hang.
        for (const conn of open) conn.destroy();
        server.close(() => res());
      }),
  };
}

/**
 * A socket path that refuses connections because the process behind it is
 * gone — the real "stale socket after a crash" case (SPEC §6), not merely an
 * unbound path. Achieved by spawning a child that binds the socket, then
 * SIGKILLing it before it can clean up, so the file survives but nothing
 * answers. Returns the path plus a cleanup for the leftover file.
 */
export async function deadOpencodeSocket(): Promise<{ path: string; cleanup(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'tincan-oc-dead-'));
  const path = join(dir, 'inst-dead.sock');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer(()=>{}).listen(${JSON.stringify(path)}, () => { console.log('up'); }); setInterval(()=>{}, 1000);`,
    ]);
    const onData = (d: Buffer) => {
      if (!d.toString().includes('up')) return;
      child.stdout.off('data', onData);
      // The child's own exit is the signal, not a fixed sleep. The kernel
      // releases the listening socket as part of tearing the process down,
      // so by the time 'exit' fires a connect is refused — deterministically,
      // on any runner. The old 200ms was a guess that a slower CI box could
      // invalidate, and the failure would have looked like a real bug in
      // the stale-socket path rather than a flaky fixture.
      child.once('exit', () => {
        // Confirmed rather than assumed: if something did answer, this
        // fixture is not doing its job and should say so here rather than
        // mislead whichever test consumes it.
        const probe = net.createConnection(path);
        probe.on('error', () => { probe.destroy(); resolve(); });
        probe.on('connect', () => {
          probe.destroy();
          reject(new Error(`deadOpencodeSocket: ${path} still accepts connections after SIGKILL`));
        });
      });
      child.kill('SIGKILL');
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
  });

  return {
    path,
    cleanup: () => {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
