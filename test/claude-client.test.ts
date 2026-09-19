import { describe, test, expect, afterEach } from 'vitest';
import { fakeInbox, type FakeInbox } from './fakes.js';
import { sendToInbox } from '../src/claude/client.js';

let inbox: FakeInbox | undefined;
afterEach(async () => {
  await inbox?.close();
  inbox = undefined;
});

const auth = { peerToken: 'a'.repeat(32), procStart: 'Sat Sep 19 11:21:13 2026', pidDomain: 'darwin' };

describe('sendToInbox', () => {
  test('authenticates with peerToken, the field Claude Code 2.1.267 actually reads', async () => {
    inbox = await fakeInbox();
    await sendToInbox({ socketPath: inbox.path, auth, text: 'hello', msgId: 'msg_a' });
    expect(inbox.lines[0]).toEqual({ type: 'auth', ...auth });
  });

  test('sends the message as a type:"user" frame, not the legacy message_from shape', async () => {
    inbox = await fakeInbox();
    await sendToInbox({ socketPath: inbox.path, auth, text: 'hello there', msgId: 'msg_a' });
    expect(inbox.lines[1]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello there' },
      priority: 'next',
      msg_id: 'msg_a',
    });
  });

  test('reports delivery when the inbox accepts the frames', async () => {
    inbox = await fakeInbox();
    const r = await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    expect(r.delivered).toBe(true);
    expect(r.notice).toBeUndefined();
  });

  test('surfaces a hold receipt as a notice without calling it a failure', async () => {
    inbox = await fakeInbox();
    inbox.replyWith.push(
      JSON.stringify({
        type: 'peer_message_status',
        orig_msg_id: 'msg_a',
        status: 'held',
        detail: 'crossSessionInbound is "hold"',
      }),
    );
    const r = await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    expect(r.delivered).toBe(true);
    expect(r.notice).toContain('held');
  });

  test('reports a refusing socket as unreachable so the registry can prune it', async () => {
    inbox = await fakeInbox({ accept: false });
    const r = await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    expect(r.delivered).toBe(false);
    expect(r.unreachable).toBe(true);
  });

  test('writes a complete line immediately, never holding the connection open empty', async () => {
    inbox = await fakeInbox();
    const started = Date.now();
    await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    // Claude Code closes a connection with no complete line within 30s; we must
    // be nowhere near that, and the frames must already have landed.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(inbox.lines.length).toBe(2);
  });
});
