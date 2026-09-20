import type { DeliveryOutcome, InboundMessage, Transport, TransportResponse } from './types.js';

/**
 * The v2 API is prefixed /api/. Without the prefix opencode returns 200 and
 * the SPA's HTML, so a dropped prefix looks exactly like success. SPEC §3.
 */
export function promptUrl(sessionID: string): string {
  return `/api/session/${sessionID}/prompt`;
}

export interface PromptBody {
  prompt: { text: string };
  delivery: 'queue' | 'steer';
  id: string;
}

export function promptBody(msg: InboundMessage): PromptBody {
  return {
    // Verbatim. The <peer_message> envelope is the only provenance marking on
    // this path and must never be trimmed or reformatted. SPEC §7.
    prompt: { text: msg.text },
    // Always explicit: opencode defaults to "steer", Tin Can defaults to queue.
    delivery: msg.delivery,
    id: msg.message_id,
  };
}

export function interpret(res: TransportResponse, alreadySent: boolean): DeliveryOutcome {
  const status = res.response?.status ?? 0;
  const data: unknown = res.data;

  if (typeof data === 'string' && data.trimStart().toLowerCase().startsWith('<!doctype')) {
    return { kind: 'transport-broken', detail: 'html response — wrong route prefix?' };
  }

  if (status >= 400) {
    const err = (typeof res.error === 'object' && res.error !== null ? res.error : {}) as Record<string, unknown>;
    return {
      kind: 'rejected',
      status,
      tag: typeof err._tag === 'string' ? err._tag : 'unknown',
      detail: typeof err.message === 'string' ? err.message : '',
    };
  }

  const admitted = (data as { data?: { admittedSeq?: unknown } } | undefined)?.data;
  if (typeof admitted?.admittedSeq === 'number') {
    return { kind: 'delivered', admittedSeq: admitted.admittedSeq, replay: alreadySent };
  }
  return { kind: 'transport-broken', detail: 'no admittedSeq in 200 response' };
}

export async function deliver(transport: Transport, msg: InboundMessage, alreadySent: Set<string>): Promise<DeliveryOutcome> {
  const replay = alreadySent.has(msg.message_id);
  let res: TransportResponse;
  try {
    res = await transport.post({ url: promptUrl(msg.to_session), body: promptBody(msg) });
  } catch (e) {
    return { kind: 'transport-broken', detail: String(e) };
  }
  const outcome = interpret(res, replay);
  if (outcome.kind === 'delivered') alreadySent.add(msg.message_id);
  return outcome;
}
