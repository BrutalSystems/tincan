import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { listenLines, probeSocket, type ServerHandle } from '../tincan-lib/server.js';

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

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('listenLines', () => {
  it('binds the socket at mode 0600', async () => {
    const path = join(dir, 'inst-a.sock');
    handle = await listenLines({ path, onLine: () => {}, onError: () => {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('delivers one newline-terminated line', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}\n');
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('delivers a final line with no trailing newline', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}');
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('splits two lines arriving in one write', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await send(path, '{"a":1}\n{"b":2}\n');
    await settle();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a line split across two writes', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: () => {} });
    await new Promise<void>((resolve, reject) => {
      const c = connect(path, () => {
        c.write('{"a":');
        setTimeout(() => c.end('1}\n'), 20);
      });
      c.on('close', () => resolve());
      c.on('error', reject);
    });
    await settle();
    expect(lines).toEqual(['{"a":1}']);
  });

  it('drops an oversize line without delivering it and keeps accepting', async () => {
    const path = join(dir, 'inst-a.sock');
    const lines: string[] = [];
    const errors: unknown[] = [];
    handle = await listenLines({ path, onLine: (l) => lines.push(l), onError: (e) => errors.push(e) });
    await send(path, `${'x'.repeat(300 * 1024)}\n`);
    await settle();
    await send(path, '{"ok":1}\n');
    await settle();
    expect(lines).toEqual(['{"ok":1}']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('survives a handler that throws', async () => {
    const path = join(dir, 'inst-a.sock');
    let second = false;
    handle = await listenLines({
      path,
      onLine: (l) => { if (l === 'boom') throw new Error('handler exploded'); second = true; },
      onError: () => {},
    });
    await send(path, 'boom\n');
    await settle();
    await send(path, 'fine\n');
    await settle();
    expect(second).toBe(true);
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

  it('removes the socket file on close', async () => {
    const path = join(dir, 'inst-a.sock');
    const h = await listenLines({ path, onLine: () => {}, onError: () => {} });
    await h.close();
    expect(existsSync(path)).toBe(false);
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
