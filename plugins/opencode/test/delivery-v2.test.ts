import { describe, it, expect, vi } from 'vitest';
import { deliverV2, type PromptV2 } from '../tincan-lib/delivery-v2.js';
import type { InboundMessage } from '../tincan-lib/types.js';

const msg: InboundMessage = {
  to_session: 'ses_a',
  message_from: 'billing-api',
  text: '<peer_message from="billing-api" runtime="claude-code" id="msg_825882f9aebd42dda4d71d15">hi</peer_message>',
  delivery: 'queue',
  message_id: 'msg_825882f9aebd42dda4d71d15',
};

/** What 2.0.24's ctx.session.prompt resolved with on a live session. */
const admitted = {
  id: msg.message_id,
  sessionID: 'ses_a',
  time: { created: 1791391533559 },
  type: 'user',
  payload: { text: msg.text },
  delivery: 'queue',
};

/** opencode 2.x fails with tagged errors, not HTTP statuses. */
const tagged = (tag: string) => Object.assign(new Error(tag), { _tag: tag });

describe('deliverV2', () => {
  it('prompts with our message id, the text verbatim and the requested delivery', async () => {
    const prompt = vi.fn<PromptV2>().mockResolvedValue(admitted);
    const out = await deliverV2(prompt, msg, new Set());
    expect(prompt).toHaveBeenCalledWith({
      sessionID: 'ses_a',
      id: 'msg_825882f9aebd42dda4d71d15',
      text: msg.text,
      delivery: 'queue',
    });
    expect(out).toEqual({ kind: 'delivered', replay: false });
  });

  it('passes steer through — 2.x has the delivery mode 1.x lacked', async () => {
    const prompt = vi.fn<PromptV2>().mockResolvedValue({ ...admitted, delivery: 'steer' });
    await deliverV2(prompt, { ...msg, delivery: 'steer' }, new Set());
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ delivery: 'steer' });
  });

  it('reports a second send of the same id as a replay', async () => {
    // 2.0.24 answers a re-submitted id with the original message, unchanged.
    const prompt = vi.fn<PromptV2>().mockResolvedValue(admitted);
    const sent = new Set<string>();
    await deliverV2(prompt, msg, sent);
    expect(await deliverV2(prompt, msg, sent)).toEqual({ kind: 'delivered', replay: true });
  });

  it('rejects, naming the tag, when the session does not exist', async () => {
    const prompt = vi.fn<PromptV2>().mockRejectedValue(tagged('Session.NotFoundError'));
    expect(await deliverV2(prompt, msg, new Set())).toMatchObject({
      kind: 'rejected',
      tag: 'Session.NotFoundError',
    });
  });

  it('rejects a schema error rather than calling it a broken transport', async () => {
    const prompt = vi.fn<PromptV2>().mockRejectedValue(tagged('SchemaError'));
    expect(await deliverV2(prompt, msg, new Set())).toMatchObject({ kind: 'rejected', tag: 'SchemaError' });
  });

  it('turns an untagged throw into transport-broken instead of propagating', async () => {
    const prompt = vi.fn<PromptV2>().mockRejectedValue(new Error('server gone'));
    expect(await deliverV2(prompt, msg, new Set())).toEqual({
      kind: 'transport-broken',
      detail: 'Error: server gone',
    });
  });

  it('does not count an answer for a different message as delivered', async () => {
    const prompt = vi.fn<PromptV2>().mockResolvedValue({ ...admitted, id: 'msg_other' });
    expect(await deliverV2(prompt, msg, new Set())).toMatchObject({ kind: 'transport-broken' });
  });

  it('does not mark a failed send as sent', async () => {
    const prompt = vi.fn<PromptV2>().mockRejectedValueOnce(new Error('nope')).mockResolvedValue(admitted);
    const sent = new Set<string>();
    await deliverV2(prompt, msg, sent);
    expect(await deliverV2(prompt, msg, sent)).toEqual({ kind: 'delivered', replay: false });
  });
});
