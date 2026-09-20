import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeLineHandler } from '../tincan-lib/plugin.js';
import { makeLogger } from '../tincan-lib/log.js';
import type { RegistryRecord, Transport } from '../tincan-lib/types.js';

const envelope = '<peer_message from="billing-api" id="msg_01J8">\nDo the thing.\n</peer_message>';
const line = (over: Record<string, unknown> = {}) => JSON.stringify({
  to_session: 'ses_a',
  message_from: 'billing-api',
  text: envelope,
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
  ...over,
});

const record: RegistryRecord = {
  session_id: 'ses_a', slug: 'nimble-wizard', title: 't', directory: '/repo',
  state: 'idle', socket: '/s.sock', instance_id: 'inst-self', pid: 1,
  plugin_version: '1.0.0', opencode_version: '1.18.31', updated_at: '2026-09-19T14:02:11Z',
};

/** prompt_async answers 204 with an empty body. */
const admitted = { response: { status: 204 } };

let logs: string[];
let known: Map<string, RegistryRecord>;
let sent: Set<string>;

beforeEach(() => {
  logs = [];
  known = new Map([['ses_a', record]]);
  sent = new Set();
});

function harness(post: ReturnType<typeof vi.fn>) {
  const transport = { post, get: vi.fn() } as unknown as Transport;
  return makeLineHandler({ transport, known, sent, log: makeLogger((l) => logs.push(l)) });
}

describe('makeLineHandler', () => {
  it('delivers a well-formed line for a known session', async () => {
    const post = vi.fn().mockResolvedValue(admitted);
    await harness(post)(line());
    expect(post).toHaveBeenCalledWith({
      url: '/session/ses_a/prompt_async',
      body: { parts: [{ type: 'text', text: envelope }], messageID: 'msg_01J8TESTAAAAAAAAAAAAAAAA' },
    });
    expect(logs.join('\n')).toContain('event=delivered');
  });

  it('drops a line for a session it never heard announced, without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)(line({ to_session: 'ses_unknown' }));
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail="unknown session"');
  });

  it('drops malformed JSON without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)('{"to_session":');
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail="malformed json"');
  });

  it('drops a bad message id without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)(line({ message_id: 'nope' }));
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('detail="bad message_id"');
  });

  it('logs the second send of one id as a replay', async () => {
    const handle = harness(vi.fn().mockResolvedValue(admitted));
    await handle(line());
    await handle(line());
    expect(logs.filter((l) => l.includes('event=replay'))).toHaveLength(1);
  });

  it('logs a 404 as rejected with its status and tag', async () => {
    const post = vi.fn().mockResolvedValue({
      response: { status: 404 },
      error: { _tag: 'SessionNotFoundError', message: 'Session not found: ses_a' },
    });
    await harness(post)(line());
    const out = logs.join('\n');
    expect(out).toContain('event=rejected');
    expect(out).toContain('status=404');
    expect(out).toContain('detail=SessionNotFoundError');
  });

  it('logs a 200-with-HTML as a broken transport, not a delivery', async () => {
    const post = vi.fn().mockResolvedValue({ response: { status: 200 }, data: '<!doctype html>' });
    await harness(post)(line());
    expect(logs.join('\n')).toContain('event=transport-broken');
    expect(logs.join('\n')).not.toContain('event=delivered');
  });

  it('never throws, even when the transport rejects', async () => {
    const post = vi.fn().mockRejectedValue(new Error('socket closed'));
    await expect(harness(post)(line())).resolves.toBeUndefined();
  });

  it('drops a line whose text is not enveloped, without calling the transport', async () => {
    const post = vi.fn();
    await harness(post)(line({ text: 'bare text, no envelope' }));
    expect(post).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('missing envelope');
  });

  it('never writes message text to the log on any path', async () => {
    // Enveloped, because an unenveloped body is now dropped at the wire —
    // this test is about the delivered / rejected / threw paths.
    const secret = `<peer_message from="billing-api" id="msg_01J8">TOP SECRET BODY</peer_message>`;
    for (const post of [
      vi.fn().mockResolvedValue(admitted),
      vi.fn().mockResolvedValue({ response: { status: 404 }, error: { _tag: 'SessionNotFoundError', message: 'x' } }),
      vi.fn().mockRejectedValue(new Error('boom')),
    ]) {
      await harness(post)(line({ text: secret }));
    }
    await harness(vi.fn())(line({ text: secret, delivery: 'urgent' }));
    expect(logs.join('\n')).not.toContain('TOP SECRET');
  });

  it('still resolves when the logger itself throws on every call', async () => {
    const brokenLogger = vi.fn().mockImplementation(() => { throw new Error('logger exploded'); });
    const transport = { post: vi.fn().mockResolvedValue(admitted), get: vi.fn() } as unknown as Transport;
    const handler = makeLineHandler({ transport, known, sent, log: brokenLogger });
    await expect(handler(line())).resolves.toBeUndefined();
    // Despite logging failing, the handler still called transport.post
    expect(transport.post).toHaveBeenCalled();
  });
});
