import { MESSAGE_ID_RE, SESSION_ID_RE, type Delivery, type InboundMessage } from './types.js';

/** One line, one message. Anything larger is a sender bug or an attack. */
export const MAX_LINE_BYTES = 256 * 1024;

/** Session and message IDs must be bounded to prevent body leakage via overlong ids. */
export const MAX_ID_BYTES = 128;

/**
 * The opening token of Tin Can's provenance envelope.
 *
 * Only the token, never the whole tag: `src/envelope.ts` emits
 * `<peer_message from="…" runtime="…" id="…">` and those attributes are free
 * to change. What must not change is that the envelope is there at all —
 * SPEC §7 makes it the load-bearing safety control on this path, and without
 * this check a Tin Can regression that stopped enveloping would inject text
 * indistinguishable from the operator's own with nothing noticing.
 */
export const ENVELOPE_TOKEN = '<peer_message';

export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: string };

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function parseLine(line: string): ParseResult {
  if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) return { ok: false, reason: 'oversize' };

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'malformed json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not an object' };
  }
  const o = raw as Record<string, unknown>;

  if (!str(o.to_session)) return { ok: false, reason: 'missing to_session' };
  if (!str(o.message_from)) return { ok: false, reason: 'missing message_from' };
  if (!str(o.text)) return { ok: false, reason: 'missing text' };
  if (!str(o.delivery)) return { ok: false, reason: 'missing delivery' };
  if (!str(o.message_id)) return { ok: false, reason: 'missing message_id' };

  // Presence only. The plugin never inspects, trims or conditions the
  // envelope's contents — that stays Tin Can's. SPEC §7.
  if (!o.text.includes(ENVELOPE_TOKEN)) return { ok: false, reason: 'missing envelope' };

  if (!SESSION_ID_RE.test(o.to_session)) return { ok: false, reason: 'bad to_session' };
  if (Buffer.byteLength(o.to_session, 'utf8') > MAX_ID_BYTES) return { ok: false, reason: 'bad to_session' };
  if (!MESSAGE_ID_RE.test(o.message_id)) return { ok: false, reason: 'bad message_id' };
  if (Buffer.byteLength(o.message_id, 'utf8') > MAX_ID_BYTES) return { ok: false, reason: 'bad message_id' };
  // message_from is peer-controlled and reaches the operator's log. Bound it
  // like the ids, or it is the one wire field a sender can use to push an
  // arbitrary amount of its own text into a log line.
  if (Buffer.byteLength(o.message_from, 'utf8') > MAX_ID_BYTES) return { ok: false, reason: 'bad message_from' };
  if (o.delivery !== 'queue' && o.delivery !== 'steer') return { ok: false, reason: 'bad delivery' };

  return {
    ok: true,
    message: {
      to_session: o.to_session,
      message_from: o.message_from,
      text: o.text,
      delivery: o.delivery as Delivery,
      message_id: o.message_id,
    },
  };
}
