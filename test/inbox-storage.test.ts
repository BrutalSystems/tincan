import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { InboxStorage } from '../src/inbox/storage.js';
import type { InboxIdentity, InboxSnapshot } from '../src/inbox/types.js';
let dir: string;
let root: string;
let storage: InboxStorage;
const who: InboxIdentity = {
  runtime: 'codex',
  id: '00000000-0000-0000-0000-000000000001',
};
const state = (): InboxSnapshot => ({
  version: 1,
  enabled: true,
  generation: 'generation',
  receiver: who,
  grants: [],
  nextSequence: 0,
  items: [],
  keys: [],
});
const receiverDir = () =>
  join(root, createHash('sha256').update(who.id).digest('hex'), who.runtime);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-inbox-'));
  root = join(dir, 'inboxes');
  storage = new InboxStorage({ root });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('absent state is disabled without creating a marker', async () => {
  expect(await storage.inspect(who)).toEqual({ enabled: false });
  expect(existsSync(root)).toBe(false);
});
test('missing and corrupt snapshots behind markers fail closed', async () => {
  mkdirSync(receiverDir(), { recursive: true, mode: 0o700 });
  await expect(storage.inspect(who)).rejects.toMatchObject({
    code: 'policy_corrupt',
  });
  writeFileSync(join(receiverDir(), 'state.json'), '{"enabled":false}', {
    mode: 0o600,
  });
  await expect(storage.inspect(who)).rejects.toMatchObject({
    code: 'policy_corrupt',
  });
});
test('symlinked root is not followed', async () => {
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, root);
  await expect(storage.inspect(who)).rejects.toMatchObject({
    code: 'storage_failed',
  });
});
test('serialized transactions preserve all increments and isolate runtime identities', async () => {
  await storage.transaction(who, () => ({ state: state(), result: undefined }));
  await Promise.all(
    Array.from({ length: 20 }, () =>
      storage.transaction(who, (s) => ({
        state: { ...s!, nextSequence: s!.nextSequence + 1 },
        result: undefined,
      })),
    ),
  );
  const n = await storage.transaction(who, (s) => ({
    state: s!,
    result: s!.nextSequence,
  }));
  expect(n).toBe(20);
  expect(await storage.inspect({ ...who, runtime: 'claude-code' })).toEqual({
    enabled: false,
  });
  expect(await storage.inspectId(who.id)).toEqual([
    { enabled: true, generation: 'generation', receiver: who },
  ]);
});
test('live and unknown lock owners time out without reclaiming the lock', async () => {
  await storage.transaction(who, () => ({ state: state(), result: undefined }));
  const lock = join(
    root,
    '.locks',
    createHash('sha256').update(`codex:${who.id}`).digest('hex'),
  );
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'live' }),
    { mode: 0o600 },
  );
  for (const probeOwner of [() => 'alive' as const, () => 'unknown' as const]) {
    const locked = new InboxStorage({ root, lockTimeoutMs: 30, probeOwner });
    await expect(
      locked.transaction(who, (s) => ({ state: s!, result: undefined })),
    ).rejects.toMatchObject({ code: 'locked' });
    expect(existsSync(lock)).toBe(true);
  }
});
test('a failed transaction leaves the committed state unchanged', async () => {
  await storage.transaction(who, () => ({ state: state(), result: undefined }));
  await expect(
    storage.transaction(who, () => {
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  expect(await storage.inspect(who)).toEqual({
    enabled: true,
    generation: 'generation',
    receiver: who,
  });
});
test("independent processes cannot lose each other's writes", async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await storage.transaction(who, () => ({ state: state(), result: undefined }));
  await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, [
        'test/fixtures/inbox-writer.mjs',
        root,
      ]),
    ),
  );
  expect(
    await storage.transaction(who, (s) => ({
      state: s!,
      result: s!.nextSequence,
    })),
  ).toBe(20);
});
test('rename failure preserves previous state and sync uncertainty is explicit', async () => {
  const { vi } = await import('vitest');
  const { promises: fs } = await import('node:fs');
  await storage.transaction(who, () => ({ state: state(), result: undefined }));
  const spy = vi
    .spyOn(fs, 'rename')
    .mockRejectedValueOnce(Object.assign(new Error('IO'), { code: 'EIO' }));
  await expect(
    storage.transaction(who, (s) => ({
      state: { ...s!, generation: 'new' },
      result: undefined,
    })),
  ).rejects.toMatchObject({ code: 'storage_failed' });
  spy.mockRestore();
  expect(await storage.inspect(who)).toMatchObject({
    generation: 'generation',
  });
  const original = fs.open.bind(fs);
  const openSpy = vi
    .spyOn(fs, 'open')
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (args[0] === receiverDir())
        vi.spyOn(file, 'sync').mockRejectedValueOnce(
          Object.assign(new Error('IO'), { code: 'EIO' }),
        );
      return file;
    });
  await expect(
    storage.transaction(who, (s) => ({
      state: { ...s!, generation: 'new' },
      result: undefined,
    })),
  ).rejects.toMatchObject({ code: 'commit_unknown' });
  openSpy.mockRestore();
  expect(await storage.inspect(who)).toMatchObject({ generation: 'new' });
});
test('interrupted committed writer reconciles its original key after operator lock recovery', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { InboxService } = await import('../src/inbox/service.js');
  const { buildEnvelope } = await import('../src/envelope.js');
  const svc = new InboxService(storage);
  const { generation } = await svc.enable(who);
  const args = {
    receiver: who,
    generation,
    namespace: 'external:test',
    key: 'stable',
    urgent: false,
    envelope: buildEnvelope({
      id: 'msg_crashed',
      from: { runtime: 'external', name: 'test' },
      to: { runtime: 'codex', name: 'receiver', thread_id: who.id },
      method: 'pull-inbox',
      text: 'retained exactly once',
      expect_reply: false,
      reply_tool: true,
    }),
  };
  await expect(
    promisify(execFile)(process.execPath, [
      'test/fixtures/inbox-crash.mjs',
      root,
      JSON.stringify(args),
    ]),
  ).rejects.toMatchObject({ code: 75 });
  const lock = join(
    root,
    '.locks',
    createHash('sha256').update(`codex:${who.id}`).digest('hex'),
  );
  expect(existsSync(lock)).toBe(true);
  // Child exit is confirmed above; recovery is deliberately an operator action.
  rmSync(lock, { recursive: true });
  const restarted = new InboxService(new InboxStorage({ root }));
  expect(
    await restarted.enqueue({
      ...args,
      envelope: { ...args.envelope, id: 'msg_retry' },
    }),
  ).toMatchObject({ message_id: 'msg_crashed', duplicate: true });
  expect((await restarted.quarantine(who, {})).messages).toHaveLength(1);
});
