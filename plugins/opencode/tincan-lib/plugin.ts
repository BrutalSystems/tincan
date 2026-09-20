import { composeCaller, isTincanTool, writeCaller } from './caller.js';
import { deliver } from './delivery.js';
import { effectOf } from './events.js';
import { makeLogger, type Logger } from './log.js';
import { socketPath } from './paths.js';
import {
  composeRecord, isoStamp, removeAllForInstance, removeRecord,
  sameIgnoringTimestamp, sweepOrphans, writeRecord, type RecordContext,
} from './registry.js';
import { listenLines, probeSocket, type ServerHandle } from './server.js';
import { PLUGIN_VERSION, type RegistryRecord, type SessionState, type Transport } from './types.js';
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

export interface PluginDeps {
  dir: string;
  instanceId: string;
  pid: number;
  transport: Transport;
  now: () => Date;
  sink: (line: string) => void;
}

export interface PluginHooks {
  event: (input: { event: unknown }) => Promise<void>;
  'tool.execute.before': (input: unknown) => Promise<void>;
  dispose: () => Promise<void>;
}

async function selfCheck(transport: Transport, log: Logger): Promise<boolean> {
  try {
    const res = await transport.get({ url: '/api/session' });
    if (typeof res.data === 'string') {
      log({ event: 'selfcheck.failed', detail: 'html response' });
      return false;
    }
    if ((res.response?.status ?? 0) !== 200) {
      log({ event: 'selfcheck.failed', status: res.response?.status });
      return false;
    }
    return true;
  } catch (e) {
    log({ event: 'selfcheck.failed', detail: String(e) });
    return false;
  }
}

export async function startPlugin(deps: PluginDeps): Promise<PluginHooks> {
  const log = makeLogger(deps.sink);
  const known = new Map<string, RegistryRecord>();
  const sent = new Set<string>();
  let server: ServerHandle | null = null;

  const sock = socketPath(deps.dir, deps.instanceId);
  const ctx: RecordContext = {
    socket: sock,
    instance_id: deps.instanceId,
    pid: deps.pid,
    plugin_version: PLUGIN_VERSION,
    now: deps.now,
  };

  const handleLine = makeLineHandler({ transport: deps.transport, known, sent, log });

  if (await selfCheck(deps.transport, log)) {
    try {
      const swept = await sweepOrphans(deps.dir, deps.instanceId, probeSocket);
      if (swept.length > 0) log({ event: 'swept', detail: swept.join(',') });
      server = await listenLines({
        path: sock,
        onLine: (line) => { void handleLine(line); },
        onError: (e) => log({ event: 'socket.error', detail: String(e) }),
      });
      log({ event: 'bound', detail: sock });
    } catch (e) {
      log({ event: 'bind.failed', detail: String(e) });
      server = null;
    }
  }

  /** Write only when something other than the timestamp changed: session.updated
   *  fires repeatedly while the model rewrites the title. SPEC §5. */
  const apply = async (sessionID: string, state: SessionState, incoming?: RegistryRecord): Promise<void> => {
    const base = incoming ?? known.get(sessionID);
    if (!base) return; // Never announced, so not addressable. SPEC §5.
    const candidate: RegistryRecord = { ...base, state, updated_at: isoStamp(ctx.now()) };
    const prev = known.get(sessionID);
    if (prev && sameIgnoringTimestamp(prev, candidate)) return;
    known.set(sessionID, candidate);
    await writeRecord(deps.dir, candidate);
  };

  return {
    event: async (input: { event: unknown }): Promise<void> => {
      if (!server) return; // Advertising without a delivery path would be a lie.
      try {
        // opencode's real contract wraps the payload as { event }. Tolerate a
        // bare event too: getting this normalisation wrong produces silent
        // inertness (effectOf sees no `type` and returns 'ignore' forever),
        // the worst failure mode there is, and a future opencode change
        // narrowing or widening the wrapper must not silently switch the
        // plugin off again.
        const event = (input as { event?: unknown } | null)?.event ?? input;
        const effect = effectOf(event);
        switch (effect.kind) {
          case 'upsert': {
            const state = known.get(effect.info.id)?.state ?? 'idle';
            await apply(effect.info.id, state, composeRecord(effect.info, state, ctx));
            return;
          }
          case 'state':
            await apply(effect.sessionID, effect.state);
            return;
          case 'remove':
            known.delete(effect.sessionID);
            await removeRecord(deps.dir, effect.sessionID);
            return;
          default:
            return;
        }
      } catch (e) {
        log({ event: 'event.failed', detail: String(e) });
      }
    },

    'tool.execute.before': async (input: unknown): Promise<void> => {
      if (!server) return; // No delivery path, so no session worth excluding.
      try {
        const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        if (typeof i.tool !== 'string' || typeof i.sessionID !== 'string') return;
        if (!isTincanTool(i.tool)) return;
        await writeCaller(deps.dir, composeCaller(i.sessionID, i.tool, ctx));
      } catch (e) {
        log({ event: 'caller.failed', detail: String(e) });
      }
    },

    dispose: async (): Promise<void> => {
      try {
        await removeAllForInstance(deps.dir, deps.instanceId);
        if (server) await server.close();
      } catch (e) {
        log({ event: 'dispose.failed', detail: String(e) });
      } finally {
        // A closed ServerHandle is still a truthy object, and the event hook's
        // only gate is `if (!server) return`. Without clearing these, a
        // fire-and-forget onLine dispatch racing dispose could resurrect a
        // deleted registry file pointing at a socket that no longer exists —
        // exactly the undeliverable-entry state the self-check exists to
        // prevent. Idempotent: a second dispose() finds server already null.
        server = null;
        known.clear();
      }
    },
  };
}
