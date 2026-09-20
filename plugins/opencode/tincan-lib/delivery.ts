import type { DeliveryOutcome, InboundMessage, Transport, TransportResponse } from './types.js';

/**
 * The v1 route, deliberately, and deliberately NOT under /api.
 *
 * There are two prompt APIs and they are different engines. The /api one
 * (`HttpApi.make("server")` in packages/protocol, self-described as an
 * "Experimental HttpApi surface for selected instance routes") admits the
 * message durably and asks a run coordinator to drain it. On a TUI-hosted
 * session that drain fails to resolve the session's model and dies before the
 * agent runs — 20 observed failures across two unrelated providers, zero
 * successes — while telling nobody: the POST has already answered 200 and no
 * error is written into the session.
 *
 * This one goes through SessionPrompt.Service instead and simply runs.
 * Verified on stock opencode 1.18.31 in a TUI-hosted session: three sends,
 * three turns, three answers. It is also what the reference integration
 * (Intelligent-Internet/opencode-a2a) posts to.
 *
 * Do not "fix" this back to /api/. The old comment here warned that a missing
 * prefix returns SPA HTML — true of the /api surface's own paths, and the
 * reason `interpret` still guards for HTML, but this is a different route on
 * a different API, not that one with a prefix dropped.
 */
export function promptUrl(sessionID: string): string {
  return `/session/${sessionID}/prompt_async`;
}

export interface TextPart {
  type: 'text';
  text: string;
}

/**
 * PromptPayload is PromptInput minus sessionID (opencode
 * packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:70).
 * `parts` is the only required field; a text part needs only `type` and
 * `text`. Everything else — model, agent, system, variant, noReply — is
 * optional and deliberately left unset: Tin Can delivers a message, it does
 * not reconfigure the peer's session.
 *
 * Note what is absent: `delivery`. v1 has no steer/queue, so `urgent` cannot
 * be expressed on this leg and `runtimeSupportsUrgent` reports false for
 * opencode accordingly. Sending a `delivery` key here would 400.
 */
export interface PromptBody {
  parts: TextPart[];
  messageID: string;
}

export function promptBody(msg: InboundMessage): PromptBody {
  return {
    // Verbatim. The <peer_message> envelope is the only provenance marking on
    // this path and must never be trimmed or reformatted. SPEC §7.
    parts: [{ type: 'text', text: msg.text }],
    // Our id, so message_log lines and opencode's own records agree.
    messageID: msg.message_id,
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

  // prompt_async answers 204 with an empty body. Anything else in the 2xx
  // range means we reached something that is not prompt_async — most likely
  // the old /api route, which answered 200 — and reading that as success is
  // how a half-applied upgrade would go unnoticed.
  if (status === 204) return { kind: 'delivered', replay: alreadySent };
  return { kind: 'transport-broken', detail: `expected 204 from prompt_async, got ${status}` };
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
