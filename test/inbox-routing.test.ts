import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools, type Side, type SidePeer } from '../src/tools.js';
import { MessageLog } from '../src/log.js';
import { InboxService } from '../src/inbox/service.js';
import { InboxStorage } from '../src/inbox/storage.js';
import { FileIdempotencyStore } from '../src/cli-idempotency.js';
import { sendCliLine } from '../src/send-cli.js';
import { CLAUDE_LIMITS } from '../src/guard.js';
import type { MailRouting } from '../src/mail-routing.js';
let dir: string;
let log: MessageLog;
let svc: InboxService;
let side: Side;
let mail: MailRouting;
let native: number;
let filed: number;
let peers: SidePeer[];
const receiver = {
  runtime: 'claude-code' as const,
  id: '00000000-0000-0000-0000-000000000001',
};
const sender = {
  runtime: 'codex' as const,
  id: '00000000-0000-0000-0000-000000000002',
};
const peer: SidePeer = {
  runtime: receiver.runtime,
  uuid: receiver.id,
  rawName: 'receiver',
  cwd: '/src/receiver',
  state: 'idle',
};
const body = 'PRIVATE_BODY_SENTINEL';
const make = () =>
  createTools(
    side,
    log,
    new FileIdempotencyStore(join(dir, 'keys')),
    mail,
    svc,
  );
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-routing-'));
  native = 0;
  filed = 0;
  peers = [peer];
  log = new MessageLog(join(dir, 'messages.jsonl'));
  svc = new InboxService(new InboxStorage({ root: join(dir, 'inboxes') }), {
    audit: (id, state, at) => log.appendInboxEvent(id, state, at),
  });
  await svc.enable(receiver);
  side = {
    selfRuntime: 'codex',
    resolveSelf: async () => ({ sessionId: sender.id }),
    selfDurableId: async () => ({ thread_id: sender.id }),
    selfName: async () => 'sender',
    selfCwd: '/src/sender',
    peerRuntimes: ['claude-code'],
    listPeers: async () => ({ peers }),
    limitsFor: () => CLAUDE_LIMITS,
    deliver: async () => {
      native++;
      return { delivered: true, method: 'inbox' };
    },
  };
  mail = {
    recipient: () => ({
      name: 'receiver',
      canonicalId: `claude-code:receiver.${receiver.id}`,
      id: receiver.id,
    }),
    deliverPrefixes: () => ['PRIVATE'],
    commandSender: () => 'sender',
    commandName: () => 'mailbox',
    file: async () => {
      filed++;
      return { ok: false, error: 'unavailable' };
    },
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
test('strict quarantine precedes urgent, prefix, sender and mailbox fallback exceptions', async () => {
  const r = await make().send_peer({
    peer: 'receiver',
    message: body,
    urgent: true,
  });
  expect(r).toMatchObject({
    outcome: 'accepted',
    method: 'pull-inbox',
    inbox_state: 'quarantined',
  });
  expect(native).toBe(0);
  expect(filed).toBe(0);
  expect((await svc.read(receiver, {})).messages).toEqual([]);
  expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(body);
  expect(JSON.parse(sendCliLine(r))).toMatchObject({
    method: 'pull-inbox',
    inbox_state: 'quarantined',
  });
});
test('resolved unreachable strict receiver accepts a granted message', async () => {
  peers = [{ ...peer, state: 'unreachable' }];
  await svc.grant(receiver, sender);
  expect(
    await make().send_peer({ peer: 'receiver', message: body }),
  ).toMatchObject({
    outcome: 'accepted',
    method: 'pull-inbox',
    inbox_state: 'queued',
  });
  expect((await svc.read(receiver, {})).messages[0]?.envelope.text).toBe(body);
  expect(native).toBe(0);
});
test('unknown target with bare expect_id cannot leak body through missed log', async () => {
  peers = [];
  const tools = make();
  expect(
    await tools.send_peer({
      peer: 'receiver',
      expect_id: receiver.id,
      replay_for_minutes: 30,
      message: body,
    }),
  ).toMatchObject({ outcome: 'rejected', refusal: 'peer_unknown' });
  expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(body);
  expect(
    JSON.stringify(await tools.message_log({ all_projects: true })),
  ).not.toContain(body);
});
test('changed target cannot leak the intended strict receiver body', async () => {
  peers = [{ ...peer, uuid: '00000000-0000-0000-0000-000000000099' }];
  expect(
    await make().send_peer({
      peer: 'receiver',
      expect_id: receiver.id,
      message: body,
    }),
  ).toMatchObject({ refusal: 'peer_changed' });
  expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(body);
  expect(native).toBe(0);
});
test('storage errors and generation changes never fall back to native delivery', async () => {
  vi.spyOn(svc, 'preflight').mockRejectedValueOnce(new Error('disk failed'));
  expect(
    await make().send_peer({ peer: 'receiver', message: body }),
  ).toMatchObject({ outcome: 'failed' });
  expect(native).toBe(0);
  expect(filed).toBe(0);
});
test('strict retry uses body-free keys and remains safe after peer exit', async () => {
  const first = await make().send_peer({
    peer: 'receiver',
    message: body,
    idempotency_key: 'k',
  });
  expect(first.outcome).toBe('accepted');
  peers = [];
  expect(
    await make().send_peer({
      peer: 'receiver',
      message: body,
      idempotency_key: 'k',
    }),
  ).toMatchObject({ refusal: 'duplicate_send', message_id: first.message_id });
  const contents = readdirSync(join(dir, 'keys'))
    .map((n) => readFileSync(join(dir, 'keys', n), 'utf8'))
    .join('');
  expect(contents).not.toContain(body);
  expect(native).toBe(0);
});
test('separate identified senders do not collide in the outer retry cache', async () => {
  const one = await make().send_peer({
    peer: 'receiver',
    message: 'one',
    idempotency_key: 'k',
  });
  side = {
    ...side,
    selfDurableId: async () => ({
      thread_id: '00000000-0000-0000-0000-000000000003',
    }),
  };
  const two = await make().send_peer({
    peer: 'receiver',
    message: 'two',
    idempotency_key: 'k',
  });
  expect(two.outcome).toBe('accepted');
  expect(two.message_id).not.toBe(one.message_id);
});
test('audit failure after insertion cannot claim a failed send or inject it', async () => {
  const tools = make();
  vi.spyOn(log, 'appendOutcome').mockImplementation(() => {
    throw Error('audit unavailable');
  });
  const r = await tools.send_peer({ peer: 'receiver', message: body });
  expect(r.outcome).toBe('accepted');
  expect((await svc.quarantine(receiver, {})).messages).toHaveLength(1);
  expect(native).toBe(0);
});
test('mixed fanout preflight failure prevents every delivery', async () => {
  peers = [
    peer,
    {
      ...peer,
      rawName: 'native-peer',
      uuid: '00000000-0000-0000-0000-000000000004',
    },
  ];
  vi.spyOn(svc, 'preflight').mockRejectedValueOnce(new Error('full'));
  const r = await make().send_peer({
    peers: ['native-peer', 'receiver'],
    message: body,
  });
  expect(r.accepted).toBe(0);
  expect(native).toBe(0);
  expect(filed).toBe(0);
});
test('a mixed broadcast does not leak strict content through its native audit copy', async () => {
  peers = [
    {
      ...peer,
      rawName: 'native-peer',
      uuid: '00000000-0000-0000-0000-000000000004',
    },
    peer,
  ];
  const r = await make().send_peer({
    peers: ['native-peer', 'receiver'],
    message: body,
  });
  expect(r.accepted).toBe(2);
  expect(native).toBe(1);
  expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(body);
});
test('policy changes after preflight reject instead of injecting', async () => {
  const original = svc.preflight.bind(svc);
  vi.spyOn(svc, 'preflight').mockImplementationOnce(async (args) => {
    const result = await original(args);
    await svc.disable(receiver);
    return result;
  });
  expect(
    await make().send_peer({ peer: 'receiver', message: body }),
  ).toMatchObject({ outcome: 'rejected', refusal: 'inbox_policy_changed' });
  expect(native).toBe(0);
});
test('native delivery selected before enable can finish without an inbox lock', async () => {
  await svc.disable(receiver);
  mail = { ...mail, recipient: () => undefined };
  let started!: () => void;
  const entered = new Promise<void>((r) => (started = r));
  let finish!: () => void;
  const pending = new Promise<void>((r) => (finish = r));
  side = {
    ...side,
    deliver: async () => {
      started();
      await pending;
      native++;
      return { delivered: true, method: 'inbox' };
    },
  };
  const tools = make();
  const first = tools.send_peer({ peer: 'receiver', message: 'native before' });
  await entered;
  await svc.enable(receiver);
  finish();
  expect((await first).outcome).toBe('accepted');
  expect(
    await tools.send_peer({ peer: 'receiver', message: 'strict after' }),
  ).toMatchObject({ method: 'pull-inbox' });
  expect(native).toBe(1);
});
test('a live strict retry uses authoritative queue state rather than a stale outer cache', async () => {
  const tools = make();
  const first = await tools.send_peer({
    peer: 'receiver',
    message: body,
    idempotency_key: 'k',
  });
  await svc.grant(receiver, sender);
  expect(
    await tools.send_peer({
      peer: 'receiver',
      message: body,
      idempotency_key: 'k',
    }),
  ).toMatchObject({
    outcome: 'accepted',
    message_id: first.message_id,
    inbox_state: 'queued',
  });
});
test('peer listing advertises pull delivery and keeps unreadable policy unknown', async () => {
  const tools = make();
  expect((await tools.peers()).peers[0]).toMatchObject({ delivery: 'pull' });
  vi.spyOn(svc, 'inspect').mockRejectedValueOnce(new Error('unreadable'));
  const listed = await tools.peers();
  expect(listed.peers[0]?.delivery).toBeUndefined();
  expect(listed.notes?.join(' ')).toContain('could not be read');
});
test('retrieval rejects external and unidentified hosts without granting by name', async () => {
  side = { ...side, selfRuntime: 'external' };
  await expect(make().receive_peer_messages({})).rejects.toThrow(
    'invalid_identity',
  );
  side = {
    ...side,
    selfRuntime: 'claude-code',
    selfDurableId: async () => undefined,
  };
  await expect(make().receive_peer_messages({})).rejects.toThrow(
    'invalid_identity',
  );
});
test('a strict retry refuses a replacement receiver behind the same display name', async () => {
  const tools = make();
  const args = { peer: 'receiver', message: body, idempotency_key: 'moved' };
  const first = await tools.send_peer(args);
  expect(first.outcome).toBe('accepted');
  const replacement = {
    ...receiver,
    id: '00000000-0000-0000-0000-000000000009',
  };
  await svc.enable(replacement);
  peers = [{ ...peer, uuid: replacement.id }];
  expect(await tools.send_peer(args)).toMatchObject({
    refusal: 'duplicate_peer_moved',
    message_id: first.message_id,
  });
  expect((await svc.status(replacement)).items).toBe(0);
});
test('partial mixed broadcast failure keeps the retry file body-free', async () => {
  peers.push({
    ...peer,
    uuid: '00000000-0000-0000-0000-000000000009',
    rawName: 'native',
  });
  const { InboxError } = await import('../src/inbox/types.js');
  vi.spyOn(svc, 'enqueue').mockRejectedValueOnce(
    new InboxError('policy_changed'),
  );
  const r = await make().send_peer({
    peers: ['native', 'receiver'],
    message: body,
    idempotency_key: 'partial',
  });
  expect(r.accepted).toBe(1);
  for (const file of readdirSync(join(dir, 'keys')))
    expect(readFileSync(join(dir, 'keys', file), 'utf8')).not.toContain(body);
});
test.each(['canonical', 'display'])(
  'unknown broadcast sibling does not expose %s strict body',
  async (kind) => {
    const address =
      kind === 'canonical' ? `claude-code:receiver.${receiver.id}` : 'receiver';
    expect(
      await make().send_peer({ peers: ['unknown', address], message: body }),
    ).toMatchObject({ refusal: 'peer_unknown' });
    expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(
      body,
    );
  },
);
test('offline padded canonical address keeps unsent body private', async () => {
  peers = [];
  expect(
    await make().send_peer({
      peer: `  claude-code:receiver.${receiver.id}  `,
      message: body,
    }),
  ).toMatchObject({ refusal: 'peer_unknown' });
  expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(body);
});
test('a failed duplicate attempt cannot rewrite successful reply history', async () => {
  const { buildEnvelope } = await import('../src/envelope.js');
  const { InboxError } = await import('../src/inbox/types.js');
  log.appendMessage(
    buildEnvelope({
      id: 'question',
      from: {
        runtime: 'claude-code',
        name: 'receiver',
        session_id: receiver.id,
      },
      to: { runtime: 'codex', name: 'sender', thread_id: sender.id },
      method: 'inbox',
      text: 'question',
      expect_reply: true,
      reply_tool: true,
    }),
    true,
  );
  await svc.grant(receiver, sender);
  const tools = make();
  const args = {
    peer: 'receiver',
    message: body,
    idempotency_key: 'answer',
    answers: true,
    in_reply_to: 'question',
  };
  const first = await tools.send_peer(args);
  expect(
    log.read({ last_n: 20 }).find((r) => r.id === 'question'),
  ).toMatchObject({ answered: true });
  vi.spyOn(svc, 'enqueue').mockRejectedValueOnce(new InboxError('locked'));
  expect(await tools.send_peer(args)).toMatchObject({ outcome: 'failed' });
  expect(
    log
      .read({ last_n: 20 })
      .find((r) => r.id === first.message_id && r.kind === undefined),
  ).toMatchObject({ outcome: 'accepted' });
  expect(
    log.read({ last_n: 20 }).find((r) => r.id === 'question'),
  ).toMatchObject({ answered: true });
});
test('a strict retry uses the recipient snapshot that validated its cached identity', async () => {
  const tools = make();
  const args = {
    peer: 'receiver',
    message: body,
    idempotency_key: 'moving-during-retry',
  };
  const first = await tools.send_peer(args);
  const replacement = {
    ...receiver,
    id: '00000000-0000-0000-0000-000000000009',
  };
  await svc.enable(replacement);
  let calls = 0;
  side.listPeers = async () => ({
    peers: ++calls === 1 ? [peer] : [{ ...peer, uuid: replacement.id }],
  });
  expect(await tools.send_peer(args)).toMatchObject({
    message_id: first.message_id,
  });
  expect((await svc.status(replacement)).items).toBe(0);
});
