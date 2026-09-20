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
