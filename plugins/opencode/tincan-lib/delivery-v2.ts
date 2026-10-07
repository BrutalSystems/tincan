import type { Delivery, DeliveryOutcome, InboundMessage } from './types.js';

/** The slice of opencode 2.x's `ctx.session.prompt` this plugin uses. */
export interface PromptV2Input {
  sessionID: string;
  id: string;
  text: string;
  delivery: Delivery;
}
export type PromptV2 = (input: PromptV2Input) => Promise<unknown>;

/**
 * opencode 2.x delivery: the plugin context's own `session.prompt`, so no
 * private transport and no route to get wrong — the two things SPEC §3 spends
 * most of its length on are 1.x-only.
 *
 * Verified on 2.0.24 from inside a plugin: the message is enqueued and run as
 * a turn; our `msg_…` id is accepted as the message id; re-submitting an id
 * resolves with the original message (even with different text), which is
 * what makes a retry safe; a missing session throws `Session.NotFoundError`
 * and a malformed id throws `SchemaError`. Failures are tagged errors, not
 * HTTP statuses, so a rejection carries status 0 and the tag.
 */
export async function deliverV2(
  prompt: PromptV2,
  msg: InboundMessage,
  alreadySent: Set<string>,
): Promise<DeliveryOutcome> {
  const replay = alreadySent.has(msg.message_id);
  let res: unknown;
  try {
    res = await prompt({
      sessionID: msg.to_session,
      id: msg.message_id,
      // Verbatim: the <peer_message> envelope is the only provenance marking.
      text: msg.text,
      // 1.x had no delivery mode to pass; 2.x does, so steer means steer.
      delivery: msg.delivery,
    });
  } catch (e) {
    const tag = (e as { _tag?: unknown } | null)?._tag;
    if (typeof tag === 'string') {
      return { kind: 'rejected', status: 0, tag, detail: e instanceof Error ? e.message : String(e) };
    }
    return { kind: 'transport-broken', detail: String(e) };
  }
  const id = (res as { id?: unknown } | null)?.id;
  if (id !== msg.message_id) {
    return { kind: 'transport-broken', detail: `prompt answered for ${String(id)}, not ${msg.message_id}` };
  }
  alreadySent.add(msg.message_id);
  return { kind: 'delivered', replay };
}
