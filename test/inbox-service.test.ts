import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStorage } from '../src/inbox/storage.js';
import { InboxService } from '../src/inbox/service.js';
import { buildEnvelope } from '../src/envelope.js';
import type { InboxIdentity, EnqueueArgs } from '../src/inbox/types.js';
let dir: string;
let svc: InboxService;
let now = 1000;
let generation: string;
const receiver: InboxIdentity = {
  runtime: 'codex',
  id: '00000000-0000-0000-0000-000000000001',
};
const sender: InboxIdentity = {
  runtime: 'claude-code',
  id: '00000000-0000-0000-0000-000000000002',
};
const message = (
  id = 'msg_one',
  text = 'hello',
  key?: string,
): EnqueueArgs => ({
  receiver,
  generation,
  sender,
  namespace: 'agent:sender',
  key,
  urgent: false,
  envelope: buildEnvelope({
    id,
    from: { runtime: 'claude-code', name: 'sender', session_id: sender.id },
    to: { runtime: 'codex', name: 'receiver', thread_id: receiver.id },
    method: 'pull-inbox',
    text,
    expect_reply: false,
    reply_tool: true,
  }),
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-inbox-service-'));
  now = 1000;
  svc = new InboxService(new InboxStorage({ root: join(dir, 'inboxes') }), {
    now: () => now,
  });
  generation = (await svc.enable(receiver)).generation;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('quarantine, grant, revoke and explicit release remain distinct', async () => {
  expect(await svc.enqueue(message())).toMatchObject({
    inbox_state: 'quarantined',
  });
  expect((await svc.read(receiver, {})).messages).toEqual([]);
  await svc.grant(receiver, sender);
  const page = await svc.read(receiver, {});
  expect(page.messages[0]?.envelope.id).toBe('msg_one');
  await svc.revoke(receiver, sender);
  expect((await svc.read(receiver, {})).messages).toEqual([]);
  await svc.release(receiver, 'msg_one');
  await svc.revoke(receiver, sender);
  expect(
    (
      await svc.read(
        receiver,
        'next_cursor' in page ? { cursor: page.next_cursor } : {},
      )
    ).messages[0]?.envelope.id,
  ).toBe('msg_one');
});
test('missing sender identity does not match grants', async () => {
  await svc.grant(receiver, sender);
  expect(await svc.enqueue({ ...message(), sender: undefined })).toMatchObject({
    inbox_state: 'quarantined',
  });
});
test('enable is idempotent and old generations cannot insert or read after re-enable', async () => {
  await svc.grant(receiver, sender);
  await svc.enqueue(message());
  const page = await svc.read(receiver, {});
  expect((await svc.enable(receiver)).generation).toBe(generation);
  expect((await svc.status(receiver)).grants).toEqual([sender]);
  expect(await svc.disable(receiver)).toMatchObject({ discarded: 1 });
  await svc.enable(receiver);
  await expect(svc.enqueue(message())).rejects.toMatchObject({
    code: 'policy_changed',
  });
  await expect(
    svc.read(receiver, {
      cursor: 'next_cursor' in page ? page.next_cursor : '',
    }),
  ).rejects.toMatchObject({ code: 'cursor_invalid' });
});
test('retrieval repeats without a cursor and paginates at 20 with a maximum of 100', async () => {
  await svc.grant(receiver, sender);
  for (let i = 0; i < 25; i++) await svc.enqueue(message(`msg_${i}`));
  const page = await svc.read(receiver, {});
  expect(page.messages).toHaveLength(20);
  expect(await svc.read(receiver, {})).toEqual(page);
  if (!page.enabled) throw Error('disabled');
  expect(page.has_more).toBe(true);
  const next = await svc.read(receiver, { cursor: page.next_cursor });
  expect(next.messages).toHaveLength(5);
  await expect(svc.read(receiver, { limit: 101 })).rejects.toThrow();
  await expect(svc.read(receiver, { cursor: 'forged' })).rejects.toMatchObject({
    code: 'cursor_invalid',
  });
});
test('release appears beyond cursor and original insertion expiry is fixed', async () => {
  const empty = await svc.read(receiver, {});
  if (!empty.enabled) throw Error('disabled');
  await svc.enqueue(message());
  await svc.release(receiver, 'msg_one');
  expect(
    (await svc.read(receiver, { cursor: empty.next_cursor })).messages,
  ).toHaveLength(1);
  now += 86400000;
  expect((await svc.read(receiver, {})).messages).toHaveLength(0);
});
test('strict key retry survives restart and drop without resurrecting content', async () => {
  await svc.grant(receiver, sender);
  const first = await svc.enqueue(message('msg_one', 'hello', 'key'));
  svc = new InboxService(new InboxStorage({ root: join(dir, 'inboxes') }), {
    now: () => now,
  });
  expect(await svc.enqueue(message('msg_two', 'hello', 'key'))).toMatchObject({
    ...first,
    duplicate: true,
  });
  await svc.drop(receiver, 'msg_one');
  expect(await svc.enqueue(message('msg_three', 'hello', 'key'))).toMatchObject(
    { message_id: 'msg_one', duplicate: true },
  );
  expect((await svc.read(receiver, {})).messages).toHaveLength(0);
  await expect(
    svc.enqueue(message('msg_other', 'different', 'key')),
  ).rejects.toMatchObject({ code: 'key_reused' });
});
test('quarantine cap reserves space for eligible items', async () => {
  for (let i = 0; i < 100; i++) await svc.enqueue(message(`held_${i}`));
  await expect(svc.enqueue(message('held_over'))).rejects.toMatchObject({
    code: 'queue_full',
  });
  await svc.grant(receiver, sender);
  await svc.enqueue(message('eligible'));
  expect((await svc.status(receiver)).items).toBe(101);
  await svc.revoke(receiver, sender);
  expect((await svc.status(receiver)).quarantined).toBe(101);
  await expect(svc.enqueue(message('over_again'))).rejects.toMatchObject({
    code: 'queue_full',
  });
});
test('response bytes are bounded for multibyte text without stalling pagination', async () => {
  await svc.grant(receiver, sender);
  for (let i = 0; i < 3; i++)
    await svc.enqueue(message(`large_${i}`, '🙂'.repeat(95000)));
  const first = await svc.read(receiver, {});
  expect(Buffer.byteLength(JSON.stringify(first.messages))).toBeLessThanOrEqual(
    1048576,
  );
  expect(first.messages).toHaveLength(2);
  if (!first.enabled) throw Error('disabled');
  expect(
    (await svc.read(receiver, { cursor: first.next_cursor })).messages,
  ).toHaveLength(1);
  await expect(
    svc.enqueue(message('too_large', '🙂'.repeat(270000))),
  ).rejects.toMatchObject({ code: 'queue_full' });
});
test('total capacity rejects the newest item without eviction', async () => {
  await svc.grant(receiver, sender);
  for (let i = 0; i < 500; i++) await svc.enqueue(message(`item_${i}`));
  await expect(svc.enqueue(message('overflow'))).rejects.toMatchObject({
    code: 'queue_full',
  });
  expect((await svc.status(receiver)).items).toBe(500);
  expect((await svc.read(receiver, {})).messages[0]?.envelope.id).toBe(
    'item_0',
  );
}, 20000);
test('byte capacity is enforced separately from item count', async () => {
  await svc.grant(receiver, sender);
  for (let i = 0; i < 10; i++)
    await svc.enqueue(message(`byte_${i}`, 'x'.repeat(900000)));
  await svc.enqueue(message('byte_10', 'x'.repeat(900000)));
  await expect(
    svc.enqueue(message('byte_over', 'x'.repeat(900000))),
  ).rejects.toMatchObject({ code: 'queue_full' });
});
test('foreign cursor is rejected and different sender key does not collide', async () => {
  await svc.enqueue(message('first', 'one', 'key'));
  expect(
    await svc.enqueue({
      ...message('second', 'two', 'key'),
      namespace: 'agent:another',
    }),
  ).toMatchObject({ message_id: 'second', duplicate: false });
  const other = { ...receiver, id: '00000000-0000-0000-0000-000000000009' };
  await svc.enable(other);
  const page = await svc.read(other, {});
  if (!page.enabled) throw Error('disabled');
  await expect(
    svc.read(receiver, { cursor: page.next_cursor }),
  ).rejects.toMatchObject({ code: 'cursor_invalid' });
});
test('admission reserves response space for revoke and sequence growth', async () => {
  await svc.grant(receiver, sender);
  const seed = message('boundary', '');
  await svc.enqueue(seed);
  const page = await svc.read(receiver, {});
  const overhead = Buffer.byteLength(JSON.stringify(page.messages));
  await svc.drop(receiver, 'boundary');
  await expect(
    svc.enqueue({
      ...seed,
      envelope: { ...seed.envelope, text: 'x'.repeat(1048576 - overhead) },
    }),
  ).rejects.toMatchObject({ code: 'queue_full' });
  const safe = {
    ...seed,
    envelope: { ...seed.envelope, text: 'x'.repeat(1048576 - overhead - 32) },
  };
  await svc.enqueue(safe);
  await svc.revoke(receiver, sender);
  expect((await svc.quarantine(receiver, {})).messages).toHaveLength(1);
  await svc.release(receiver, 'boundary');
  expect((await svc.read(receiver, {})).messages).toHaveLength(1);
});
test('admission reserves total snapshot space so revocation remains possible', async () => {
  await svc.grant(receiver, sender);
  for (let i = 0; i < 100; i++)
    await svc.enqueue(message(`bulk_${i}`, 'x'.repeat(100000)));
  const seed = message('last', '');
  await svc.enqueue(seed);
  const serialized = await svc.storage.transaction(receiver, (s) => ({
    state: s!,
    result: JSON.stringify(s),
  }));
  const padding = 10485760 - Buffer.byteLength(serialized);
  await svc.drop(receiver, 'last');
  await expect(
    svc.enqueue({
      ...seed,
      envelope: { ...seed.envelope, text: 'x'.repeat(padding) },
    }),
  ).rejects.toMatchObject({ code: 'queue_full' });
  await svc.revoke(receiver, sender);
  expect((await svc.status(receiver)).eligible).toBe(0);
  expect((await svc.status(receiver)).quarantined).toBe(100);
}, 20000);
