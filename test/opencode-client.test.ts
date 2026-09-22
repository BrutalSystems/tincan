import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type net from 'node:net';
import {
  fakeOpencodeInstance,
  fakeOpencodeInstanceNeverCloses,
  deadOpencodeSocket,
  type FakeOpencodeInstance,
} from './fakes.js';
import { sendToInstance } from '../src/opencode/client.js';

let instance: FakeOpencodeInstance | undefined;
afterEach(async () => {
  await instance?.close();
  instance = undefined;
});

describe('sendToInstance', () => {
  test('writes exactly the five wire fields, one JSON object on one line', async () => {
    instance = await fakeOpencodeInstance();
    const r = await sendToInstance({
      socketPath: instance.path,
      toSession: 'ses_abc123',
      from: 'billing-api',
      text: 'hello there',
      delivery: 'queue',
      messageId: 'msg_01J8',
    });
    expect(r.delivered).toBe(true);
    expect(instance.rawLines.length).toBe(1);
    expect(JSON.parse(instance.rawLines[0]!)).toEqual({
      to_session: 'ses_abc123',
      message_from: 'billing-api',
      text: 'hello there',
      delivery: 'queue',
      message_id: 'msg_01J8',
    });
  });

  test('maps urgent delivery to "steer" and default delivery to "queue" verbatim', async () => {
    instance = await fakeOpencodeInstance();
    await sendToInstance({
      socketPath: instance.path,
      toSession: 'ses_abc123',
      from: 'billing-api',
      text: 'x',
      delivery: 'steer',
      messageId: 'msg_01J8',
    });
    expect(JSON.parse(instance.rawLines[0]!).delivery).toBe('steer');
  });

  test('passes the enveloped text through byte-identical, not a substring match', async () => {
    instance = await fakeOpencodeInstance();
    const text = [
      '<peer_message from="auth-refactor" runtime="codex" id="msg_01J8">',
      'Ünïcödé, "quotes", back\\slashes, and a\nnewline.',
      '</peer_message>',
      '',
      'From another agent, not from your user.',
    ].join('\n');

    await sendToInstance({
      socketPath: instance.path,
      toSession: 'ses_abc123',
      from: 'billing-api',
      text,
      delivery: 'queue',
      messageId: 'msg_01J8',
    });

    const wire = JSON.parse(instance.rawLines[0]!) as { text: string };
    expect(Buffer.from(wire.text, 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
  });

  test('reports a refused socket (crashed instance) as unreachable, not a throw', async () => {
    const dead = await deadOpencodeSocket();
    try {
      const r = await sendToInstance({
        socketPath: dead.path,
        toSession: 'ses_abc123',
        from: 'billing-api',
        text: 'hi',
        delivery: 'queue',
        messageId: 'msg_01J8',
      });
      expect(r.delivered).toBe(false);
      expect(r.unreachable).toBe(true);
    } finally {
      dead.cleanup();
    }
  });

  test('reports a socket path that does not exist as unreachable, not a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tincan-oc-missing-'));
    try {
      const r = await sendToInstance({
        socketPath: join(dir, 'no-such-instance.sock'),
        toSession: 'ses_abc123',
        from: 'billing-api',
        text: 'hi',
        delivery: 'queue',
        messageId: 'msg_01J8',
      });
      expect(r.delivered).toBe(false);
      expect(r.unreachable).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    'a connection that closes without the write ever landing reports delivered:false — ' +
      'the close handler and the fallback timer must agree on what `wrote` means',
    async () => {
      // No 'connect', so the write never happens; the peer's side just goes
      // away. Resolving delivered:true here reported success for a message
      // that was never put on the socket at all, and nothing downstream —
      // Tin Can's own log included — could ever contradict it.
      const fake = new EventEmitter() as unknown as net.Socket;
      fake.end = (() => fake) as net.Socket['end'];
      fake.destroy = (() => fake) as net.Socket['destroy'];

      const pending = sendToInstance(
        {
          socketPath: '/does/not/matter',
          toSession: 'ses_abc123',
          from: 'billing-api',
          text: 'hi',
          delivery: 'queue',
          messageId: 'msg_01J8',
          // Long enough that only the close handler can settle this.
          fallbackMs: 10_000,
        },
        { connect: () => fake },
      );
      fake.emit('close');

      expect(await pending).toEqual({ delivered: false, unreachable: true });
    },
  );

  describe('the fallback timer (peer never closes its side, or never connects at all)', () => {
    test('resolves delivered:true once the write has happened, even if the peer never closes', async () => {
      instance = await fakeOpencodeInstanceNeverCloses();
      const started = Date.now();
      const r = await sendToInstance({
        socketPath: instance.path,
        toSession: 'ses_abc123',
        from: 'billing-api',
        text: 'hi',
        delivery: 'queue',
        messageId: 'msg_01J8',
        fallbackMs: 30,
      });
      expect(r).toEqual({ delivered: true });
      expect(instance.rawLines).toEqual([
        JSON.stringify({
          to_session: 'ses_abc123',
          message_from: 'billing-api',
          text: 'hi',
          delivery: 'queue',
          message_id: 'msg_01J8',
        }),
      ]);
      // Bounded by fallbackMs, not the 500ms production default.
      expect(Date.now() - started).toBeLessThan(300);
    });

    test(
      'resolves delivered:false, unreachable:true — never a false success — when the ' +
        'connection has not completed by the deadline, so nothing was ever written',
      async () => {
        // A real AF_UNIX connect either succeeds or fails near-instantly (Node
        // drains the kernel accept queue eagerly regardless of backlog), so a
        // genuine "never connects" stall cannot be reproduced deterministically
        // with a real socket. Doubling `connect` with a socket that simply never
        // emits 'connect' is the direct way to exercise this branch: it is the
        // one finding 1 would have caught, since the old code resolved
        // `delivered: true` here unconditionally.
        const fake = new EventEmitter() as unknown as net.Socket;
        fake.end = (() => fake) as net.Socket['end'];
        fake.destroy = (() => fake) as net.Socket['destroy'];

        const r = await sendToInstance(
          {
            socketPath: '/does/not/matter',
            toSession: 'ses_abc123',
            from: 'billing-api',
            text: 'hi',
            delivery: 'queue',
            messageId: 'msg_01J8',
            fallbackMs: 20,
          },
          { connect: () => fake },
        );
        expect(r).toEqual({ delivered: false, unreachable: true });
      },
    );
  });
});

// #9. Until the ack, `delivered: true` meant "the bytes reached the socket".
// An unknown session, a malformed frame or a 404 from opencode all looked
// exactly like success from here.
describe('sendToInstance — the plugin answers', () => {
  const send = (path: string) =>
    sendToInstance({
      socketPath: path,
      toSession: 'ses_target',
      from: 'billing-api',
      text: '<peer_message …>',
      delivery: 'queue',
      messageId: 'msg_01J8',
    });

  test('a refusal is a failure, carrying the reason', async () => {
    instance = await fakeOpencodeInstance({
      ack: JSON.stringify({ ok: false, message_id: 'msg_01J8', reason: 'unknown session ses_target' }),
    });
    const r = await send(instance.path);
    expect(r.delivered).toBe(false);
    expect(r.error).toContain('unknown session');
    // Not unreachable: the peer is alive and answered. It said no.
    expect(r.unreachable).toBeUndefined();
  });

  test('an acceptance is a delivery', async () => {
    instance = await fakeOpencodeInstance({
      ack: JSON.stringify({ ok: true, message_id: 'msg_01J8', status: 'delivered' }),
    });
    expect((await send(instance.path)).delivered).toBe(true);
  });

  test('a plugin too old to answer still counts as delivered', async () => {
    // The version-skew case. The plugin installs separately from the core, so
    // a silent listener must behave exactly as it did before the ack existed.
    instance = await fakeOpencodeInstance();
    expect((await send(instance.path)).delivered).toBe(true);
  });

  test('a reply that is not an ack falls back rather than failing', async () => {
    instance = await fakeOpencodeInstance({ ack: 'not json at all' });
    expect((await send(instance.path)).delivered).toBe(true);
  });
})
