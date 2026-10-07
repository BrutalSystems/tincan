import {
  composeCallTicket,
  composeCaller,
  isTincanTool,
  removeCallTicket,
  writeCallTicket,
  writeCaller,
} from './caller.js';
import { deliver } from './delivery.js';
import { effectOf as effectOfV1, type EventEffect } from './events.js';
import { makeLogger, swallow, type Logger } from './log.js';
import { socketPath } from './paths.js';
import {
  composeRecord, isoStamp, removeAllForInstance, removeRecord,
  sameIgnoringTimestamp, sweepOrphans, writeRecord, type RecordContext,
} from './registry.js';
import { listenLines, probeSocket, type ServerHandle } from './socket.js';
import {
  PLUGIN_VERSION, type DeliveryOutcome, type InboundMessage, type RegistryRecord, type SessionInfo,
  type SessionState, type Transport,
} from './types.js';
import { parseLine, renderAck, type Ack } from './wire.js';

/** Hands one message to opencode. 1.x posts through the private transport;
 *  2.x calls the plugin context's own session.prompt. */
export type Deliver = (msg: InboundMessage, alreadySent: Set<string>) => Promise<DeliveryOutcome>;

export interface LineHandlerDeps {
  /** 1.x: delivery goes through this unless `deliver` is given. */
  transport?: Transport;
  deliver?: Deliver;
  /** Sessions this process heard announced. Anything else is not addressable. */
  known: Map<string, RegistryRecord>;
  sent: Set<string>;
  log: Logger;
}

/**
 * Returns the ack the sender gets back. Every `return` here is a sender-visible
 * answer, not just a log line — until 0.9.0 the only signal was "the bytes
 * arrived", so a drop and a delivery were indistinguishable to Tin Can (#9).
 */
export function makeLineHandler(deps: LineHandlerDeps): (line: string) => Promise<Ack> {
  // Wrapped once, here, because deps.log is caller-supplied; called bare
  // everywhere below. SPEC §8.1.
  const log = swallow(deps.log);
  const send: Deliver = deps.deliver ?? ((m, s) => deliver(deps.transport as Transport, m, s));
  return async (line: string): Promise<Ack> => {
    try {
      const parsed = parseLine(line);
      if (!parsed.ok) {
        log({ event: 'dropped', detail: parsed.reason });
        return { ok: false, reason: `malformed frame: ${parsed.reason}` };
      }
      const msg = parsed.message;
      if (!deps.known.has(msg.to_session)) {
        log({
          event: 'dropped',
          session: msg.to_session,
          from: msg.message_from,
          message_id: msg.message_id,
          detail: 'unknown session',
        });
        return {
          ok: false,
          message_id: msg.message_id,
          reason: `unknown session ${msg.to_session} on this opencode instance`,
        };
      }
      const outcome = await send(msg, deps.sent);
      log({
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
      if (outcome.kind === 'delivered') {
        return {
          ok: true,
          message_id: msg.message_id,
          status: outcome.replay ? 'replay' : 'delivered',
        };
      }
      return {
        ok: false,
        message_id: msg.message_id,
        reason:
          outcome.kind === 'rejected'
            ? outcome.status === 0
              // 2.x fails with a tagged error and no HTTP status to report.
              ? `opencode refused the prompt (${outcome.tag})`
              : `opencode refused the prompt (status ${String(outcome.status)}${
                  outcome.tag === undefined ? '' : `: ${outcome.tag}`
                })`
            : `opencode transport failed: ${outcome.detail}`,
      };
    } catch (e) {
      // Nothing here may reach the host. SPEC §8.1. The sender is told the
      // message did not land rather than being left to infer it from a
      // closed socket, which would read as success.
      log({ event: 'handler.failed', detail: String(e) });
      return { ok: false, reason: `plugin handler failed: ${String(e)}` };
    }
  };
}

export interface PluginDeps {
  dir: string;
  instanceId: string;
  pid: number;
  /** 1.x only. 2.x supplies `deliver` and `selfCheck` instead. */
  transport?: Transport;
  /** Overrides delivery through `transport`. */
  deliver?: Deliver;
  /** Overrides the 1.x startup check against `transport`. */
  selfCheck?: () => Promise<boolean>;
  /** Overrides the 1.x event mapping; 2.x events have a different shape. */
  effectOf?: (event: unknown) => EventEffect;
  now: () => Date;
  sink: (line: string) => void;
}

export interface PluginHooks {
  event: (input: { event: unknown }) => Promise<void>;
  'tool.execute.before': (input: unknown) => Promise<void>;
  'tool.execute.after': (input: unknown) => Promise<void>;
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

/**
 * The fields both tool hooks need, or `undefined` when this is not a Tin Can
 * tool call worth recording. Shared so the two hooks cannot drift into
 * disagreeing about what counts — a ticket written by one and not removed by
 * the other is a leak the reader then has to expire.
 */
function tincanToolCall(
  input: unknown,
): { tool: string; sessionID: string; callID?: string } | undefined {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof i.tool !== 'string' || typeof i.sessionID !== 'string') return undefined;
  if (!isTincanTool(i.tool)) return undefined;
  return {
    tool: i.tool,
    sessionID: i.sessionID,
    ...(typeof i.callID === 'string' && i.callID.length > 0 && { callID: i.callID }),
  };
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

  const handleLine = makeLineHandler({ transport: deps.transport, deliver: deps.deliver, known, sent, log });
  const effectOf = deps.effectOf ?? effectOfV1;
  const healthy = deps.selfCheck
    ? await deps.selfCheck().catch(() => false)
    : deps.transport !== undefined && await selfCheck(deps.transport, log);

  if (healthy) {
    try {
      const swept = await sweepOrphans(deps.dir, deps.instanceId, probeSocket);
      if (swept.length > 0) log({ event: 'swept', detail: swept.join(',') });
      server = await listenLines({
        path: sock,
        onLine: (line) => handleLine(line).then(renderAck),
        onError: (e) => log({ event: 'socket.error', detail: String(e) }),
      });
      log({ event: 'bound', detail: sock });
    } catch (e) {
      log({ event: 'bind.failed', detail: String(e) });
      server = null;
    }
  }

  /**
   * Every mutation of `known` and of the registry directory runs through this
   * one chain. opencode dispatches events without awaiting the previous one,
   * and unserialised `set`-then-write against `delete`-then-unlink interleaves
   * into a deleted session whose file survives with a live-looking state —
   * which `known` no longer holds, so nothing ever rewrites or removes it
   * again. `then(fn, fn)` rather than `then(fn)`: a rejected link must not
   * stall the chain behind it.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next;
    return next;
  };

  /** Write only when something other than the timestamp changed: session.updated
   *  fires repeatedly while the model rewrites the title. SPEC §5.
   *
   *  `known` is updated only AFTER the write lands. Updating it first makes a
   *  failed write poison the dedup cache: the next identical event compares
   *  equal against memory and is skipped, leaving disk permanently stale. */
  const applyRecord = async (candidate: RegistryRecord): Promise<void> => {
    const prev = known.get(candidate.session_id);
    if (prev && sameIgnoringTimestamp(prev, candidate)) return;
    await writeRecord(deps.dir, candidate);
    known.set(candidate.session_id, candidate);
  };

  const applyInfo = (info: SessionInfo): Promise<void> => serial(async () => {
    const state = known.get(info.id)?.state ?? 'idle';
    await applyRecord(composeRecord(info, state, ctx));
  });

  const applyState = (sessionID: string, state: SessionState): Promise<void> => serial(async () => {
    const base = known.get(sessionID);
    if (!base) return; // Never announced, so not addressable. SPEC §5.
    await applyRecord({ ...base, state, updated_at: isoStamp(ctx.now()) });
  });

  const applyRename = (sessionID: string, title: string): Promise<void> => serial(async () => {
    const base = known.get(sessionID);
    if (!base) return;
    await applyRecord({ ...base, title, updated_at: isoStamp(ctx.now()) });
  });

  const applyRemove = (sessionID: string): Promise<void> => serial(async () => {
    known.delete(sessionID);
    await removeRecord(deps.dir, sessionID);
  });

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
          case 'upsert':
            await applyInfo(effect.info);
            return;
          case 'state':
            await applyState(effect.sessionID, effect.state);
            return;
          case 'rename':
            await applyRename(effect.sessionID, effect.title);
            return;
          case 'remove':
            await applyRemove(effect.sessionID);
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
        const i = tincanToolCall(input);
        if (i === undefined) return;
        // Both, deliberately. The caller file is what an older core reads,
        // and the plugin installs separately from the core so that skew is
        // normal. The ticket is what a current core prefers.
        await writeCaller(deps.dir, composeCaller(i.sessionID, i.tool, ctx));
        if (i.callID !== undefined) {
          await writeCallTicket(deps.dir, composeCallTicket(i.sessionID, i.tool, i.callID, ctx));
        }
      } catch (e) {
        log({ event: 'caller.failed', detail: String(e) });
      }
    },

    /**
     * The tidy path only. opencode reaches this hook by falling off the end of
     * a successful call — an error, a denied permission or an abort skip it
     * [verified against 1.18.32's MCP tool wrapper, which has no `finally`].
     * So a leaked ticket is expected, not exceptional, and the reader expires
     * tickets rather than trusting this to have run.
     *
     * The caller file is deliberately NOT removed here: it is the older core's
     * only signal, and it is overwritten rather than cleared by design.
     */
    'tool.execute.after': async (input: unknown): Promise<void> => {
      if (!server) return;
      try {
        const i = tincanToolCall(input);
        if (i?.callID === undefined) return;
        await removeCallTicket(deps.dir, deps.instanceId, i.callID);
      } catch (e) {
        log({ event: 'caller.failed', detail: String(e) });
      }
    },

    dispose: async (): Promise<void> => {
      // Order matters. Stop accepting work BEFORE removing anything: a
      // closed ServerHandle is still a truthy object, and the event hook's
      // only gate is `if (!server) return`, so a fire-and-forget onLine
      // dispatch racing dispose could otherwise resurrect a registry file
      // pointing at a socket that no longer exists — exactly the
      // undeliverable-entry state the self-check exists to prevent. Removing
      // first left the same window open for an event already in flight.
      // Idempotent: a second dispose() finds server already null.
      const handle = server;
      server = null;
      known.clear();
      try {
        if (handle) await handle.close();
        // Through the chain, so any write already queued lands before the
        // sweep rather than after it.
        await serial(() => removeAllForInstance(deps.dir, deps.instanceId));
      } catch (e) {
        log({ event: 'dispose.failed', detail: String(e) });
      }
    },
  };
}
