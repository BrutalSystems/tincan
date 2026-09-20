import { describe, it, expect, vi } from 'vitest';
import { promptUrl, promptBody, interpret, deliver } from '../tincan-lib/delivery.js';
import type { InboundMessage, Transport, TransportResponse } from '../tincan-lib/types.js';

const envelope = '<peer_message from="billing-api" id="msg_01J8">\nDo the thing.\n</peer_message>';
const msg: InboundMessage = {
  to_session: 'ses_a',
  message_from: 'billing-api',
  text: envelope,
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
};

/** prompt_async answers 204 with an empty body. There is no admittedSeq. */
const accepted = (): TransportResponse => ({ response: { status: 204 } });

describe('promptUrl', () => {
  // The v2 route /api/session/{id}/prompt admits the message and schedules a
  // turn that, on a TUI-hosted session, dies resolving the model. This one
  // runs. Verified on stock 1.18.31: three consecutive sends, three turns,
  // three answers. NOT the /api surface — that is a different HttpApi.
  it('posts to the v1 prompt_async route, with no /api prefix', () => {
    expect(promptUrl('ses_a')).toBe('/session/ses_a/prompt_async');
  });
});

describe('promptBody', () => {
  // PromptPayload is PromptInput minus sessionID (groups/session.ts:70).
  // `parts` is the only required field; a text part needs only type and text.
  it('sends the envelope as a single text part', () => {
    expect(promptBody(msg)).toEqual({
      parts: [{ type: 'text', text: envelope }],
      messageID: msg.message_id,
    });
  });

  it('passes text through byte-identically — SPEC \u00a77, the envelope is provenance', () => {
    expect(Buffer.from(promptBody(msg).parts[0]!.text)).toEqual(Buffer.from(envelope));
  });

  it('carries message_id as messageID so our log ids match opencode\u2019s', () => {
    expect(promptBody(msg).messageID).toBe(msg.message_id);
  });

  it('sends no delivery field — v1 has no steer/queue, and inventing one would 400', () => {
    expect(promptBody({ ...msg, delivery: 'steer' })).not.toHaveProperty('delivery');
    expect(promptBody({ ...msg, delivery: 'steer' })).toEqual(promptBody({ ...msg, delivery: 'queue' }));
  });
});

describe('interpret', () => {
  it('treats 204 as delivered', () => {
    expect(interpret(accepted(), false)).toEqual({ kind: 'delivered', replay: false });
  });

  it('flags a previously sent id as a replay', () => {
    expect(interpret(accepted(), true)).toEqual({ kind: 'delivered', replay: true });
  });

  it('treats a 200 as broken — this route must answer 204', () => {
    // A 200 here means we reached something other than prompt_async. The old
    // v2 route answered 200, so this is the check that catches a half-applied
    // upgrade rather than letting it read as success.
    const res: TransportResponse = { response: { status: 200 }, data: { data: { admittedSeq: 16 } } };
    expect(interpret(res, false)).toEqual({
      kind: 'transport-broken',
      detail: 'expected 204 from prompt_async, got 200',
    });
  });

  it('treats a 200 with SPA HTML as a broken transport, not a delivery', () => {
    const res: TransportResponse = { response: { status: 200 }, data: '<!doctype html>\n<html lang="en">' };
    expect(interpret(res, false)).toEqual({ kind: 'transport-broken', detail: 'html response — wrong route prefix?' });
  });

  it('reports a 404 with its tag', () => {
    const res: TransportResponse = { response: { status: 404 }, error: { _tag: 'SessionNotFoundError', sessionID: 'ses_a', message: 'Session not found: ses_a' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 404, tag: 'SessionNotFoundError', detail: 'Session not found: ses_a' });
  });

  it('reports a 400 with its tag', () => {
    // What a wrong body shape looks like: an empty body answers
    // 'Missing key at ["parts"]'.
    const res: TransportResponse = { response: { status: 400 }, error: { _tag: 'InvalidRequestError', message: 'Missing key at ["parts"]' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 400, tag: 'InvalidRequestError', detail: 'Missing key at ["parts"]' });
  });

  it('reports a 409 as rejected so the caller can treat it as already delivered', () => {
    const res: TransportResponse = { response: { status: 409 }, error: { _tag: 'ConflictError', message: 'prompt conflict' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 409, tag: 'ConflictError', detail: 'prompt conflict' });
  });

  it('falls back to a tagless rejection when the error has no _tag', () => {
    const res: TransportResponse = { response: { status: 401 }, error: {} };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 401, tag: 'unknown', detail: '' });
  });
});

describe('deliver', () => {
  it('posts to the v1 route with the documented body', async () => {
    const post = vi.fn().mockResolvedValue(accepted());
    const transport = { post, get: vi.fn() } as unknown as Transport;
    const out = await deliver(transport, msg, new Set());
    expect(post).toHaveBeenCalledWith({
      url: '/session/ses_a/prompt_async',
      body: { parts: [{ type: 'text', text: envelope }], messageID: msg.message_id },
    });
    expect(out).toEqual({ kind: 'delivered', replay: false });
  });

  it('marks a second send of the same id as a replay', async () => {
    const transport = { post: vi.fn().mockResolvedValue(accepted()), get: vi.fn() } as unknown as Transport;
    const sent = new Set<string>();
    await deliver(transport, msg, sent);
    const second = await deliver(transport, msg, sent);
    expect(second).toEqual({ kind: 'delivered', replay: true });
  });

  it('turns a thrown transport error into transport-broken instead of propagating', async () => {
    const transport = { post: vi.fn().mockRejectedValue(new Error('socket closed')), get: vi.fn() } as unknown as Transport;
    await expect(deliver(transport, msg, new Set())).resolves.toEqual({ kind: 'transport-broken', detail: 'Error: socket closed' });
  });

  it('does not record the id as sent when delivery failed', async () => {
    const transport = { post: vi.fn().mockRejectedValue(new Error('nope')), get: vi.fn() } as unknown as Transport;
    const sent = new Set<string>();
    await deliver(transport, msg, sent);
    expect(sent.has(msg.message_id)).toBe(false);
  });
});
