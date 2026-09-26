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

  /**
   * A hold and a refusal are different outcomes and must not share a verdict.
   *
   * Claude Code's inbound controls end in one of three states: delivered, held,
   * or refused. A hold may still be released by the peer's human, so it is a
   * notice (above). A refusal means the message was dropped and nothing will
   * deliver it — reporting that as `delivered` with a note attached claims more
   * than was established, which is the one thing Tin Can says it never does.
   */
  test('treats a refusal receipt as a failed delivery, not a delivered message with a note', async () => {
    inbox = await fakeInbox();
    inbox.replyWith.push(
      JSON.stringify({
        type: 'peer_message_status',
        orig_msg_id: 'msg_a',
        status: 'refused',
        detail: 'crossSessionInbound is "refuse"',
      }),
    );
    const r = await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    expect(r.delivered).toBe(false);
    expect(r.notice).toContain('refused');
  });

  /**
   * The correlation check is what makes the refusal trustworthy: a status frame
   * about someone else's message must not fail ours.
   */
  test('ignores a refusal that names a different message id', async () => {
    inbox = await fakeInbox();
    inbox.replyWith.push(
      JSON.stringify({ type: 'peer_message_status', orig_msg_id: 'msg_other', status: 'refused' }),
    );
    const r = await sendToInbox({ socketPath: inbox.path, auth, text: 'hi', msgId: 'msg_a' });
    expect(r.delivered).toBe(true);
    expect(r.notice).toBeUndefined();
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
