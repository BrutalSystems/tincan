import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileIdempotencyStore, cliIdempotencyDir } from '../src/cli-idempotency.js';
import { IDEMPOTENCY_WINDOW_MS } from '../src/idempotency.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-keys-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const prior = { messageId: 'msg_1', peer: 'muster-59', peerArg: 'muster-59', text: 'disk 91%' };

describe('cliIdempotencyDir', () => {
  test('sits under the same root as the message log', () => {
    expect(cliIdempotencyDir({ TINCAN_HOME: '/tmp/tc' }, '/home/x')).toBe('/tmp/tc/send-keys');
    expect(cliIdempotencyDir({}, '/home/x')).toBe('/home/x/.tincan/send-keys');
  });
});

describe('FileIdempotencyStore', () => {
  test('a key recorded by one instance is found by another, which is the whole point', () => {
    // Two instances stand in for two processes: the in-memory store fails this,
    // and that failure is why this class exists.
    new FileIdempotencyStore(dir).record('bd-1:7:disk', prior);
    expect(new FileIdempotencyStore(dir).lookup('bd-1:7:disk')).toMatchObject(prior);
  });

  test('an unrecorded key is absent', () => {
    expect(new FileIdempotencyStore(dir).lookup('never-used')).toBeUndefined();
  });

  test('a key outside the window reads as new rather than as already sent', () => {
    let now = 1_000_000;
    const store = new FileIdempotencyStore(dir, IDEMPOTENCY_WINDOW_MS, () => now);
    store.record('k', prior);
    expect(store.lookup('k')).toMatchObject(prior);

    now += IDEMPOTENCY_WINDOW_MS + 1;
    // Not "mysteriously refused forever": the documented behaviour is that an
    // aged-out key delivers again, and this is the assertion that says so.
    expect(store.lookup('k')).toBeUndefined();
  });

  test('a key still inside the window survives', () => {
    let now = 1_000_000;
    const store = new FileIdempotencyStore(dir, IDEMPOTENCY_WINDOW_MS, () => now);
    store.record('k', prior);
    now += IDEMPOTENCY_WINDOW_MS - 1;
    expect(store.lookup('k')).toMatchObject(prior);
  });

  test('prunes aged records on read, so the directory is not a permanent leak', () => {
    let now = 1_000_000;
    const store = new FileIdempotencyStore(dir, IDEMPOTENCY_WINDOW_MS, () => now);
    for (const k of ['a', 'b', 'c']) store.record(k, prior);
    expect(readdirSync(dir)).toHaveLength(3);

    now += IDEMPOTENCY_WINDOW_MS + 1;
    store.lookup('anything');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('keeps a fresh record while pruning a stale one', () => {
    let now = 1_000_000;
    const store = new FileIdempotencyStore(dir, IDEMPOTENCY_WINDOW_MS, () => now);
    store.record('old', prior);
    now += IDEMPOTENCY_WINDOW_MS - 10;
    store.record('new', prior);
    now += 20; // 'old' is now outside the window, 'new' is not.

    expect(store.lookup('new')).toMatchObject(prior);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test('a key containing path characters cannot escape the directory', () => {
    // A caller's key is free text. birddog's is instance:incident:condition, but
    // nothing stops a slash, and a key used as a filename directly would write
    // outside `dir` — or fail to write at all.
    const store = new FileIdempotencyStore(dir);
    const nasty = '../../etc/passwd:7:disk';
    store.record(nasty, prior);
    expect(store.lookup(nasty)).toMatchObject(prior);
    // One file, and it is inside our directory.
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  test('distinct keys do not collide', () => {
    const store = new FileIdempotencyStore(dir);
    store.record('k1', { ...prior, messageId: 'msg_1' });
    store.record('k2', { ...prior, messageId: 'msg_2' });
    expect(store.lookup('k1')?.messageId).toBe('msg_1');
    expect(store.lookup('k2')?.messageId).toBe('msg_2');
  });

  test('a record damaged by a crash mid-write reads as absent, not as already sent', () => {
    // The direction matters: treating a truncated record as a prior send would
    // silently drop a real alert, which is strictly worse than sending twice.
    const store = new FileIdempotencyStore(dir);
    store.record('k', prior);
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, '{"messageId":"msg_1","at":', 'utf8');
    expect(store.lookup('k')).toBeUndefined();
  });

  test('a directory that cannot be created never fails a send', () => {
    // Recording is best-effort by design: a key that cannot be persisted costs a
    // duplicate on retry, whereas throwing here would fail a send that already
    // succeeded.
    //
    // The unwritable path is made by putting a FILE where a directory would have
    // to go, so `mkdirSync` gets ENOTDIR. That is portable and instant.
    //
    // The first version of this test used `/proc/nonexistent/send-keys`, which
    // is why it is worth a comment: on macOS `/proc` does not exist, so it
    // errored immediately and the test was trivially green, while on the Linux
    // CI runner that is a live procfs. This file then never completed, vitest
    // waited for it, and the publish job sat for seventeen minutes and shipped
    // nothing. Never point a test's writes at a real kernel filesystem.
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'a file, not a directory', 'utf8');
    const store = new FileIdempotencyStore(join(blocker, 'send-keys'));
    expect(() => store.record('k', prior)).not.toThrow();
    expect(store.lookup('k')).toBeUndefined();
  });

  test('a stray non-JSON file in the directory is cleaned up rather than fatal', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'garbage.json'), 'not json at all', 'utf8');
    const store = new FileIdempotencyStore(dir);
    expect(() => store.lookup('k')).not.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
