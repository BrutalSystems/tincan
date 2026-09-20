import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { listenLines, probeSocket, type ServerHandle } from '../tincan-lib/server.js';

// Gated so every other test in this file runs against the real fs. There is
// no way to make a chmod of a socket we just created fail for real.
let chmodFails = false;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (path: string, mode: number) => {
      if (chmodFails && String(path).endsWith('.sock')) throw new Error('chmod refused');
      return actual.chmod(path, mode);
    },
  };
});

let dir: string;
let handle: ServerHandle | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-sock-')); });
afterEach(async () => { if (handle) { await handle.close(); handle = null; } rmSync(dir, { recursive: true, force: true }); });

function send(path: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = connect(path, () => { c.end(payload); });
    c.on('close', () => resolve());
    c.on('error', reject);
  });
}

// Bounded wait — used ONLY where the assertion is that nothing arrived.
// Absence has no event to await, so this stays a fixed sleep.
const settle = () => new Promise((r) => setTimeout(r, 60));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Event-driven signal for positive assertions: resolves once `count` lines
// have arrived, instead of sleeping a fixed amount and hoping.
function waitForLines(count: number): { onLine: (l: string) => void; lines: string[]; ready: Promise<void> } {
  const lines: string[] = [];
  const { promise: ready, resolve } = deferred();
  const onLine = (l: string) => {
    lines.push(l);
    if (lines.length >= count) resolve();
  };
  return { onLine, lines, ready };
}

describe('listenLines', () => {
  it('binds the socket at mode 0600', async () => {
    const path = join(dir, 'inst-a.sock');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('chmods an already-existing parent directory to 0700', async () => {
    const path = join(dir, 'inst-a.sock');
    chmodSync(dir, 0o755);
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('delivers one newline-terminated line', async () => {
    const path = join(dir, 'inst-a.sock');
    const { onLine, lines, ready } = waitForLines(1);
    handle = await listenLines({ path, onLine, onError: () => {} });
    await send(path, '{"a":1}\n');
    await ready;
    expect(lines).toEqual(['{"a":1}']);
  });

  it('delivers a final line with no trailing newline', async () => {
    const path = join(dir, 'inst-a.sock');
    const { onLine, lines, ready } = waitForLines(1);
    handle = await listenLines({ path, onLine, onError: () => {} });
    await send(path, '{"a":1}');
    await ready;
    expect(lines).toEqual(['{"a":1}']);
  });

  it('splits two lines arriving in one write', async () => {
    const path = join(dir, 'inst-a.sock');
    const { onLine, lines, ready } = waitForLines(2);
    handle = await listenLines({ path, onLine, onError: () => {} });
    await send(path, '{"a":1}\n{"b":2}\n');
    await ready;
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a line split across two writes', async () => {
    const path = join(dir, 'inst-a.sock');
    const { onLine, lines, ready } = waitForLines(1);
    handle = await listenLines({ path, onLine, onError: () => {} });
    await new Promise<void>((resolve, reject) => {
      const c = connect(path, () => {
        c.write('{"a":');
        setTimeout(() => c.end('1}\n'), 20);
      });
      c.on('close', () => resolve());
      c.on('error', reject);
    });
    await ready;
    expect(lines).toEqual(['{"a":1}']);
  });

  it('drops an oversize line without delivering it and keeps accepting', async () => {
    const path = join(dir, 'inst-a.sock');
    const errors: unknown[] = [];
    const { promise: gotOk, resolve } = deferred();
    const lines: string[] = [];
    handle = await listenLines({
      path,
      onLine: (l) => { lines.push(l); if (l === '{"ok":1}') resolve(); },
      onError: (e) => errors.push(e),
    });
    await send(path, `${'x'.repeat(300 * 1024)}\n`);
    await settle(); // absence: the oversize line must never have been delivered
    expect(lines).toEqual([]);
    await send(path, '{"ok":1}\n');
    await gotOk;
    expect(lines).toEqual(['{"ok":1}']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('survives a handler that throws', async () => {
    const path = join(dir, 'inst-a.sock');
    let second = false;
    const { promise: gotFine, resolve } = deferred();
    handle = await listenLines({
      path,
      onLine: (l) => { if (l === 'boom') throw new Error('handler exploded'); second = true; resolve(); },
      onError: () => {},
    });
    await send(path, 'boom\n');
    await send(path, 'fine\n');
    await gotFine;
    expect(second).toBe(true);
  });

  it('survives an onError handler that itself throws', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    const { promise: gotOk, resolve } = deferred();
    handle = await listenLines({
      path,
      onLine: (l) => { lines.push(l); if (l === '{"ok":1}') resolve(); },
      onError: () => { throw new Error('sink exploded'); },
    });
    await send(path, `${'x'.repeat(300 * 1024)}\n`); // triggers onError, which throws
    await send(path, '{"ok":1}\n');
    await gotOk;
    expect(lines).toEqual(['{"ok":1}']);
  });

  it('destroys an idle connection and keeps accepting afterwards', async () => {
    // Resource hygiene, not rate limiting: a sender that connects and never
    // closes holds a file descriptor and up to MAX_LINE_BYTES of buffer
    // inside the opencode process for as long as the instance lives.
    const path = join(dir, 'inst-a.sock');
    const { onLine, lines, ready } = waitForLines(1);
    handle = await listenLines({ path, onLine, onError: () => {}, idleTimeoutMs: 50 });

    const idle = connect(path);
    await new Promise<void>((resolve, reject) => {
      idle.on('connect', () => resolve());
      idle.on('error', reject);
    });
    await new Promise<void>((resolve) => idle.on('close', () => resolve()));
    expect(idle.destroyed).toBe(true);

    await send(path, '{"ok":1}\n');
    await ready;
    expect(lines).toEqual(['{"ok":1}']);
  });

  it('unlinks a stale socket file before binding', async () => {
    const path = join(dir, 'inst-a.sock');
    writeFileSync(path, '');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(existsSync(path)).toBe(true);
    await send(path, 'x\n');
  });

  it('refuses to bind an over-long path', async () => {
    const longDir = join(dir, 'd'.repeat(90));
    await expect(listenLines({ path: join(longDir, 'inst-a.sock'), onLine: () => {}, onError: () => {} }))
      .rejects.toThrow(/socket path too long/);
  });

  it('leaves no listening server behind when the post-listen chmod fails', async () => {
    // Rejecting straight out of listenLines used to strand a listening
    // server on a 0755 socket with no ServerHandle to close it.
    const path = join(dir, 'inst-a.sock');
    chmodFails = true;
    try {
      await expect(listenLines({ path, onLine: () => {}, onError: () => {} })).rejects.toThrow(/chmod refused/);
    } finally {
      chmodFails = false;
    }
    expect(await probeSocket(path)).toBe(false);
    // And the path is free again, which an orphaned listener would deny.
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(await probeSocket(path)).toBe(true);
  });

  it('removes the socket file on close', async () => {
    const path = join(dir, 'inst-a.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    expect(existsSync(path)).toBe(false);
  });

  it('closes promptly even with an idle client still connected', async () => {
    const path = join(dir, 'inst-a.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('error', reject);
    });
    const start = Date.now();
    await h.close();
    expect(Date.now() - start).toBeLessThan(1000);
    client.destroy();
  });

  it('is safe to call close() twice', async () => {
    const path = join(dir, 'inst-a.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
  });
});

describe('probeSocket', () => {
  it('is true for a live socket', async () => {
    const path = join(dir, 'inst-a.sock');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(await probeSocket(path)).toBe(true);
  });

  it('is false for a stale socket file nobody is listening on', async () => {
    const path = join(dir, 'inst-dead.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    writeFileSync(path, '');
    expect(await probeSocket(path)).toBe(false);
  });

  it('is false for a path that does not exist', async () => {
    expect(await probeSocket(join(dir, 'nope.sock'))).toBe(false);
  });
});
