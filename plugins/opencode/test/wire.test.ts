import { describe, it, expect } from 'vitest';
import { parseLine, MAX_LINE_BYTES, MAX_ID_BYTES } from '../tincan-lib/wire.js';

const good = {
  to_session: 'ses_f4185535affe0nxzk66nw19ihJ',
  message_from: 'billing-api',
  text: '<peer_message from="billing-api">hi</peer_message>',
  delivery: 'queue',
  message_id: 'msg_01J8TESTAAAAAAAAAAAAAAAA',
};

describe('parseLine', () => {
  it('accepts a well-formed line', () => {
    const r = parseLine(JSON.stringify(good));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual(good);
  });

  it('preserves text byte-for-byte, including newlines and quotes', () => {
    const text = '<peer_message from="a" id="msg_1">\nline\ttwo\n</peer_message>';
    const r = parseLine(JSON.stringify({ ...good, text }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message.text).toBe(text);
      expect(Buffer.from(r.message.text)).toEqual(Buffer.from(text));
    }
  });

  it('rejects truncated JSON', () => {
    const r = parseLine('{"to_session":"ses_a"');
    expect(r).toEqual({ ok: false, reason: 'malformed json' });
  });

  it('rejects a JSON array', () => {
    expect(parseLine('[]')).toEqual({ ok: false, reason: 'not an object' });
  });

  it('rejects null', () => {
    expect(parseLine('null')).toEqual({ ok: false, reason: 'not an object' });
  });

  it.each([
    ['to_session', 'missing to_session'],
    ['message_from', 'missing message_from'],
    ['text', 'missing text'],
    ['delivery', 'missing delivery'],
    ['message_id', 'missing message_id'],
  ])('rejects a line missing %s', (field, reason) => {
    const body: Record<string, unknown> = { ...good };
    delete body[field];
    expect(parseLine(JSON.stringify(body))).toEqual({ ok: false, reason });
  });

  it('rejects a session id that does not start with ses', () => {
    const r = parseLine(JSON.stringify({ ...good, to_session: 'nope_1' }));
    expect(r).toEqual({ ok: false, reason: 'bad to_session' });
  });

  it('rejects a message id that does not start with msg_', () => {
    const r = parseLine(JSON.stringify({ ...good, message_id: 'not-a-msg-id' }));
    expect(r).toEqual({ ok: false, reason: 'bad message_id' });
  });

  it('rejects an unknown delivery mode', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'urgent' }));
    expect(r).toEqual({ ok: false, reason: 'bad delivery' });
  });

  it('accepts steer', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'steer' }));
    expect(r.ok).toBe(true);
  });

  it('rejects an oversize line', () => {
    const r = parseLine(JSON.stringify({ ...good, text: 'x'.repeat(MAX_LINE_BYTES) }));
    expect(r).toEqual({ ok: false, reason: 'oversize' });
  });

  it('never includes message text in the rejection reason', () => {
    const r = parseLine(JSON.stringify({ ...good, delivery: 'urgent', text: 'SECRET BODY' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain('SECRET');
  });

  it('rejects a to_session that exceeds MAX_ID_BYTES', () => {
    const hostile = 'ses' + 'x'.repeat(MAX_ID_BYTES);
    const r = parseLine(JSON.stringify({ ...good, to_session: hostile }));
    expect(r).toEqual({ ok: false, reason: 'bad to_session' });
  });

  it('rejects a message_id that exceeds MAX_ID_BYTES', () => {
    const hostile = 'msg_' + 'x'.repeat(MAX_ID_BYTES);
    const r = parseLine(JSON.stringify({ ...good, message_id: hostile }));
    expect(r).toEqual({ ok: false, reason: 'bad message_id' });
  });

  it('accepts a to_session at exactly MAX_ID_BYTES', () => {
    const boundary = 'ses' + 'x'.repeat(MAX_ID_BYTES - 3);
    const r = parseLine(JSON.stringify({ ...good, to_session: boundary }));
    expect(r.ok).toBe(true);
  });

  it('accepts a message_id at exactly MAX_ID_BYTES', () => {
    const boundary = 'msg_' + 'x'.repeat(MAX_ID_BYTES - 4);
    const r = parseLine(JSON.stringify({ ...good, message_id: boundary }));
    expect(r.ok).toBe(true);
  });
});
