import { deliver } from './delivery.js';
import type { Logger } from './log.js';
import type { RegistryRecord, Transport } from './types.js';
import { parseLine } from './wire.js';

export interface LineHandlerDeps {
  transport: Transport;
  /** Sessions this process heard announced. Anything else is not addressable. */
  known: Map<string, RegistryRecord>;
  sent: Set<string>;
  log: Logger;
}

function safeLog(log: Logger, fields: Parameters<Logger>[0]): void {
  try {
    log(fields);
  } catch {
    // A logger's own failure must never reach the host. SPEC §8.1.
  }
}

export function makeLineHandler(deps: LineHandlerDeps): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    try {
      const parsed = parseLine(line);
      if (!parsed.ok) {
        safeLog(deps.log, { event: 'dropped', detail: parsed.reason });
        return;
      }
      const msg = parsed.message;
      if (!deps.known.has(msg.to_session)) {
        safeLog(deps.log, {
          event: 'dropped',
          session: msg.to_session,
          from: msg.message_from,
          message_id: msg.message_id,
          detail: 'unknown session',
        });
        return;
      }
      const outcome = await deliver(deps.transport, msg, deps.sent);
      safeLog(deps.log, {
        event: outcome.kind === 'delivered' ? (outcome.replay ? 'replay' : 'delivered') : outcome.kind,
        session: msg.to_session,
        from: msg.message_from,
        delivery: msg.delivery,
        message_id: msg.message_id,
        status: outcome.kind === 'rejected' ? outcome.status : undefined,
        detail:
          outcome.kind === 'rejected' ? outcome.tag
          : outcome.kind === 'transport-broken' ? outcome.detail
          : undefined,
      });
    } catch (e) {
      // Nothing here may reach the host. SPEC §8.1.
      safeLog(deps.log, { event: 'handler.failed', detail: String(e) });
    }
  };
}
