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

const admitted = (seq: number): TransportResponse => ({
  response: { status: 200 },
  data: { data: { admittedSeq: seq, id: msg.message_id, sessionID: 'ses_a', prompt: { text: envelope }, delivery: 'queue', timeCreated: 1 } },
});

describe('promptUrl', () => {
  it('uses the /api prefix — without it opencode returns 200 and SPA HTML', () => {
    expect(promptUrl('ses_a')).toBe('/api/session/ses_a/prompt');
  });
});

describe('promptBody', () => {
  it('passes delivery explicitly and reuses message_id as the idempotency key', () => {
    expect(promptBody(msg)).toEqual({ prompt: { text: envelope }, delivery: 'queue', id: msg.message_id });
  });

  it('passes text through byte-identically', () => {
    const body = promptBody(msg);
    expect(Buffer.from(body.prompt.text)).toEqual(Buffer.from(envelope));
  });

  it('never omits delivery, because opencode would default to steer', () => {
    expect(Object.keys(promptBody({ ...msg, delivery: 'steer' }))).toContain('delivery');
    expect(promptBody({ ...msg, delivery: 'steer' }).delivery).toBe('steer');
  });
});

describe('interpret', () => {
  it('treats a JSON admission as delivered', () => {
    expect(interpret(admitted(16), false)).toEqual({ kind: 'delivered', admittedSeq: 16, replay: false });
  });

  it('flags a previously sent id as a replay', () => {
    expect(interpret(admitted(16), true)).toEqual({ kind: 'delivered', admittedSeq: 16, replay: true });
  });

  it('treats a 200 with SPA HTML as a broken transport, not a delivery', () => {
    const res: TransportResponse = { response: { status: 200 }, data: '<!doctype html>\n<html lang="en">' };
    expect(interpret(res, false)).toEqual({ kind: 'transport-broken', detail: 'html response — wrong route prefix?' });
  });

  it('treats a 200 with no admittedSeq as broken', () => {
    const res: TransportResponse = { response: { status: 200 }, data: { data: {} } };
    expect(interpret(res, false)).toEqual({ kind: 'transport-broken', detail: 'no admittedSeq in 200 response' });
  });

  it('reports a 404 with its tag', () => {
    const res: TransportResponse = { response: { status: 404 }, error: { _tag: 'SessionNotFoundError', sessionID: 'ses_a', message: 'Session not found: ses_a' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 404, tag: 'SessionNotFoundError', detail: 'Session not found: ses_a' });
  });

  it('reports a 400 with its tag', () => {
    const res: TransportResponse = { response: { status: 400 }, error: { _tag: 'InvalidRequestError', message: 'Expected a string starting with "msg_"' } };
    expect(interpret(res, false)).toEqual({ kind: 'rejected', status: 400, tag: 'InvalidRequestError', detail: 'Expected a string starting with "msg_"' });
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
  it('posts to the prefixed URL with the documented body', async () => {
    const post = vi.fn().mockResolvedValue(admitted(16));
    const transport = { post, get: vi.fn() } as unknown as Transport;
    const out = await deliver(transport, msg, new Set());
    expect(post).toHaveBeenCalledWith({ url: '/api/session/ses_a/prompt', body: { prompt: { text: envelope }, delivery: 'queue', id: msg.message_id } });
    expect(out).toEqual({ kind: 'delivered', admittedSeq: 16, replay: false });
  });

  it('marks a second send of the same id as a replay', async () => {
    const transport = { post: vi.fn().mockResolvedValue(admitted(16)), get: vi.fn() } as unknown as Transport;
    const sent = new Set<string>();
    await deliver(transport, msg, sent);
    const second = await deliver(transport, msg, sent);
    expect(second).toEqual({ kind: 'delivered', admittedSeq: 16, replay: true });
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
