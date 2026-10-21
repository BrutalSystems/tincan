import { beforeEach, afterEach, test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInbox } from '../src/inbox-cli.js';
import { InboxService } from '../src/inbox/service.js';
import { InboxStorage } from '../src/inbox/storage.js';
import { buildEnvelope } from '../src/envelope.js';
let dir: string;
let service: InboxService;
const id = '00000000-0000-0000-0000-000000000001';
const sid = '00000000-0000-0000-0000-000000000002';
const receiver = `codex:receiver.${id}`;
const sender = `claude-code:sender.${sid}`;
async function run(args: string[]) {
  let out = '';
  let err = '';
  const code = await runInbox(args, {
    service,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    peers: async () => [
      { name: 'old-peer', tincan_version: '2.6.1' },
      { name: 'unknown-peer' },
    ],
  });
  return { code, out, err };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-inbox-cli-'));
  service = new InboxService(new InboxStorage({ root: join(dir, 'inboxes') }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('help works without arguments and usage errors never mutate policy', async () => {
  expect((await run(['--help'])).code).toBe(0);
  for (const args of [
    [],
    ['enable'],
    ['enable', '--receiver', receiver, '--receiver', receiver],
    ['enable', '--receiver', receiver, '--bogus', 'x'],
    ['enable', '--receiver', receiver + '@remote'],
    ['enable', '--receiver', 'external:x.foo'],
    ['drop', '--receiver', receiver],
    ['read', '--receiver', receiver, '--limit', 'NaN'],
  ])
    expect((await run(args)).code).toBe(64);
  expect(await service.inspect({ runtime: 'codex', id })).toEqual({
    enabled: false,
  });
});
test('operator lifecycle delegates to the same inbox store and returns one JSON result', async () => {
  const who = { runtime: 'codex' as const, id };
  const peer = { runtime: 'claude-code' as const, id: sid };
  const enabled = await run(['enable', '--receiver', receiver]);
  expect(enabled.code).toBe(0);
  const generation = JSON.parse(enabled.out).generation;
  expect(
    (await run(['grant', '--receiver', receiver, '--sender', sender])).code,
  ).toBe(0);
  await service.enqueue({
    receiver: who,
    generation,
    sender: peer,
    namespace: 'sender',
    urgent: false,
    envelope: buildEnvelope({
      id: 'msg_one',
      from: { runtime: 'claude-code', name: 'sender', session_id: sid },
      to: { runtime: 'codex', name: 'receiver', thread_id: id },
      method: 'pull-inbox',
      text: 'hello',
      expect_reply: false,
      reply_tool: true,
    }),
  });
  expect(
    JSON.parse((await run(['read', '--receiver', receiver])).out).messages[0]
      .envelope.text,
  ).toBe('hello');
  expect(
    (await run(['revoke', '--receiver', receiver, '--sender', sender])).code,
  ).toBe(0);
  expect(
    JSON.parse((await run(['quarantine', '--receiver', receiver])).out)
      .messages,
  ).toHaveLength(1);
  expect(
    (await run(['release', '--receiver', receiver, '--message', 'msg_one']))
      .code,
  ).toBe(0);
  const status = JSON.parse(
    (await run(['status', '--receiver', receiver])).out,
  );
  expect(status.items).toBe(1);
  expect(status.compatibility.peers).toEqual([
    { name: 'old-peer', version: '2.6.1', support: 'unsupported' },
    { name: 'unknown-peer', support: 'unknown' },
  ]);
  expect(
    (await run(['drop', '--receiver', receiver, '--message', 'msg_one'])).code,
  ).toBe(0);
  expect(
    JSON.parse((await run(['disable', '--receiver', receiver])).out).discarded,
  ).toBe(0);
  expect(
    JSON.parse((await run(['read', '--receiver', receiver])).out),
  ).toMatchObject({ enabled: false, messages: [] });
});
test('operational rejection is structured and does not leak the argument content', async () => {
  await run(['enable', '--receiver', receiver]);
  const r = await run([
    'release',
    '--receiver',
    receiver,
    '--message',
    'PRIVATE_BODY_SENTINEL',
  ]);
  expect(r.code).toBe(2);
  expect(JSON.parse(r.out)).toMatchObject({
    outcome: 'rejected',
    reason: 'item_unknown',
  });
  expect(r.err + r.out).not.toContain('PRIVATE_BODY_SENTINEL');
  const badCursor = await run([
    'read',
    '--receiver',
    receiver,
    '--cursor',
    'broken',
  ]);
  expect(badCursor.code).toBe(2);
  expect(JSON.parse(badCursor.out).reason).toBe('cursor_invalid');
});
