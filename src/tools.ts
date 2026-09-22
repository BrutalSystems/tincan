/** The three tools (§7), identical on both sides. */
import { z } from 'zod';
import { basename } from 'node:path';
import {
  assertNever,
  assignNames,
  resolvePeer,
  slugify,
  LABEL,
  type NamedPeer,
  type RuntimeName,
} from './naming.js';
import { buildEnvelope, newMessageId, renderEnvelope, type DeliveryMethod } from './envelope.js';
import { Guard, type GuardLimits, type GuardReason } from './guard.js';
import { MessageLog, type LogRecord, type LogIntegrity } from './log.js';
import { IdempotencyStore, IDEMPOTENCY_WINDOW_MS } from './idempotency.js';
import type { PeerState } from './claude/discover.js';

export interface SidePeer {
  /** The peer's own runtime. A peer list may hold more than one. */
  runtime: RuntimeName;
  rawName: string | null;
  uuid: string;
  cwd: string;
  state: PeerState;
  threadId?: string;
  socketPath?: string;
  auth?: unknown;
  /** Claude Code only: which config dir this session lives in. */
  configDir?: string;
  /**
   * Claude Code only: whether the peer can answer with send_peer. True iff it
   * wrote a pointer record, which it does only when it is running Tin Can.
   */
  canReply?: boolean;
}

export interface DeliveryOutcome {
  delivered: boolean;
  method: DeliveryMethod;
  notice?: string;
  error?: string;
  unreachable?: boolean;
}

/**
 * Who Tin Can is, for the duration of one tool call.
 *
 * Resolved once at the top of each call and threaded into everything that
 * needs it, because the opencode host's answer is not stable: the caller file
 * it reads is scoped to the instance, not to the call, and a concurrent
 * sibling session can change it underneath us (docs/change-notice-opencode.md
 * §4). Three independent resolutions inside one `send_peer` could therefore
 * name three different sessions — the envelope declaring a different sender
 * than the one the plugin logs, on the path where the envelope *is* the
 * provenance control. Threading one value does not close that race; it makes
 * its outcome internally consistent, which is a prerequisite for the
 * plugin-side `callID` fix that will.
 */
export interface SelfRef {
  /**
   * The host session's own id where the runtime can name it — opencode today.
   * `undefined` on the hosts that identify themselves from the environment
   * instead, and on opencode when the caller file cannot be read.
   */
  sessionId: string | undefined;
}

/** Everything that differs between being hosted in Claude Code and in Codex. */
/**
 * How much of its own runtime a side lists.
 *
 * `cross-config-dir` exists because the Claude arm's exclusion was never
 * about the runtime: SendMessage reaches one CLAUDE_CONFIG_DIR, so the rule
 * is "list a Claude peer only when SendMessage cannot reach it". peerRuntimes
 * alone cannot express "lists its own kind, but only some of them".
 */
export type OwnKindScope = 'included' | 'cross-config-dir';

export interface Side {
  selfRuntime: RuntimeName;
  ownKindScope: OwnKindScope;
  /**
   * Answer "which session is calling?" exactly once per tool call. The result
   * is passed back into `selfName`, `listPeers` and `deliver` so all three
   * agree with each other.
   */
  resolveSelf(): Promise<SelfRef>;
  /** Resolved lazily: the Codex side must derive its own identity at runtime. */
  selfName(self: SelfRef): Promise<string>;
  selfCwd: string;
  /** Which runtimes this side exposes. Codex-hosted exposes both. */
  peerRuntimes: RuntimeName[];
  /** Budgets are per peer runtime: Codex is tighter, since every send starts a turn. */
  limitsFor(runtime: RuntimeName): GuardLimits;
  listPeers(self: SelfRef): Promise<{ peers: SidePeer[]; diagnostic?: string }>;
  /**
   * `self` and `selfName` come first deliberately. An implementation that
   * simply forgot them would otherwise still type-check — an arrow with fewer
   * parameters is assignable — and would silently fall back to re-resolving.
   * Leading with them makes the omission a compile error.
   *
   * `selfName` is the name already resolved for this call, and is the only
   * name an implementation may use. Re-deriving it here is the defect in #2:
   * the envelope's `from=` and the opencode wire's `message_from` then come
   * from two independent reads, and our own registry record can change (or
   * vanish, dropping to the cwd fallback) in between.
   */
  deliver(
    self: SelfRef,
    selfName: string,
    peer: SidePeer,
    envelopeId: string,
    text: string,
    urgent: boolean,
  ): Promise<DeliveryOutcome>;
}

export const sendPeerSchema = z.object({
  peer: z.string(),
  message: z.string().min(1),
  in_reply_to: z.string().optional(),
  expect_reply: z.boolean().default(false),
  answers: z.boolean().default(false),
  urgent: z.boolean().default(false),
  idempotency_key: z.string().min(1).optional(),
  expect_id: z.string().min(1).optional(),
});

export const messageLogSchema = z.object({
  peer: z.string().optional(),
  thread: z.string().optional(),
  last_n: z.number().int().positive().default(20),
});

export type SendPeerArgs = z.input<typeof sendPeerSchema>;
export type MessageLogArgs = z.input<typeof messageLogSchema>;

export type Refusal =
  | 'peer_unknown'
  | 'peer_ambiguous'
  // Distinct from peer_unknown: the peer exists, it is us. A caller branching
  // on `refusal` saw "no such peer" for the one peer guaranteed to exist, and
  // on a Claude Code host peer_unknown otherwise covers three unrelated
  // situations — a typo, a session in another CLAUDE_CONFIG_DIR that is not
  // listed, and yourself.
  | 'self_send'
  | 'peer_unreachable'
  // The name resolved, but to a different session than the caller listed.
  // Distinct from peer_unreachable: that peer is fine, it is simply not the
  // one meant — and delivering to it is the failure being prevented.
  | 'peer_changed'
  // A key the caller has already used. Distinct from every other refusal
  // because nothing is wrong: the message was sent, and `message_id` names it.
  | 'duplicate_send'
  | GuardReason
  | 'delivery_failed';

export interface SendPeerResult {
  delivered: boolean;
  method?: DeliveryMethod;
  peer_state?: PeerState;
  message_id?: string;
  refusal?: Refusal;
  detail?: string;
  candidates?: string[];
  notice?: string;
}

export interface PeersResult {
  peers: Array<{
    name: string;
    /** Human-readable label; use name for send_peer. */
    display_label: string;
    canonical_id: string;
    state: PeerState;
    cwd: string;
    thread_id?: string;
    session_id?: string;
    /** Claude Code peers only: which account's config dir this session is in. */
    config_dir?: string;
    /** Claude Code peers only: false when the peer has no Tin Can to answer with. */
    can_reply?: boolean;
  }>;
  diagnostic?: string;
  notes?: string[];
}

/**
 * Every peer carries a durable id: canonical_id is not unique (see
 * CANONICAL_ID.md), so it cannot be a caller's primary key.
 */
export function durableIdOf(p: SidePeer): { thread_id: string } | { session_id: string } {
  switch (p.runtime) {
    case 'codex':
      return { thread_id: p.threadId ?? p.uuid };
    case 'claude-code':
      return { session_id: p.uuid };
    case 'opencode':
      return { session_id: p.uuid };
    default:
      return assertNever(p.runtime, 'durableIdOf');
  }
}

/**
 * Whether a peer on this runtime can have a running turn interrupted at all.
 *
 * Nothing, as of 0.6.0. opencode was the only one, through the v2 prompt
 * route's `delivery: "steer"`. That route admits a message and then, on a
 * TUI-hosted session, fails to run it — so the steer was a promise about a
 * turn that never happened. The plugin now posts to v1 `prompt_async`, which
 * actually runs the message and has no delivery mode at all.
 *
 * A reliable send with no steer beats a steer into a session that never
 * answers, so this is a deliberate trade rather than a regression waiting to
 * be undone. Kept as a function, not deleted, because the honest place to
 * describe "urgent does nothing" is still one place — tool-definitions.ts and
 * the peers note both derive from it, and three parallel derivations of one
 * fact is how drift starts.
 */
export function runtimeSupportsUrgent(_runtime: RuntimeName): boolean {
  return false;
}

/**
 * The host-native peer-messaging path that lets a runtime exclude its own kind
 * from Tin Can's peer list, named so the model is told where the missing
 * sessions actually are rather than merely that some are missing.
 *
 * Only Claude Code has one (README, "Which peers you see"). Keeping it a
 * lookup rather than a hard-coded "Claude Code" string in `tools.ts` and
 * `tool-definitions.ts` is the same single-source rule as
 * `runtimeSupportsUrgent` above: the condition is derived from `peerRuntimes`
 * vs `selfRuntime`, so a side that starts listing its own kind stops claiming
 * otherwise without anyone remembering to edit the wording.
 */
export const NATIVE_PEER_PATH: Partial<Record<RuntimeName, string>> = {
  'claude-code': 'SendMessage',
};

/** Whether this side hides the host's own kind from its peer list. */
/**
 * The human labels for a set of runtimes, as English: "Codex", "Codex and
 * opencode", "Codex, Claude Code, and opencode". Duplicates collapse.
 *
 * The single join for every runtime list Tin Can shows a model — both notes
 * here and all three tool descriptions. Four inlined `.join(' and ')` calls
 * are what produced "Codex and Claude Code and opencode" in every description
 * on the two hosts that list all three runtimes.
 */
export function labelList(runtimes: RuntimeName[]): string {
  const labels = [...new Set(runtimes)].map((r) => LABEL[r]);
  if (labels.length <= 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

export function methodFor(runtime: RuntimeName): DeliveryMethod {
  switch (runtime) {
    case 'codex':
      return 'thread/queue/add';
    case 'claude-code':
      return 'inbox';
    case 'opencode':
      return 'opencode/prompt_async';
    default:
      return assertNever(runtime, 'methodFor');
  }
}

export function createTools(side: Side, log: MessageLog) {
  // One guard per peer runtime, so a Codex peer's tight budget does not
  // throttle a Claude peer sharing the same listing.
  const guards = new Map<RuntimeName, Guard>();
  // One store for the whole process, not one per runtime: a key identifies the
  // caller's intent, and the same intent must not be sendable once per runtime.
  const idempotency = new IdempotencyStore();

  const guardFor = (runtime: RuntimeName): Guard => {
    let g = guards.get(runtime);
    if (g === undefined) {
      g = new Guard(side.limitsFor(runtime));
      guards.set(runtime, g);
    }
    return g;
  };

  async function named(self: SelfRef): Promise<{
    named: Array<NamedPeer & { side: SidePeer }>;
    diagnostic?: string;
  }> {
    const { peers, diagnostic } = await side.listPeers(self);
    const base = peers.map((p) => ({ runtime: p.runtime, rawName: p.rawName, uuid: p.uuid }));
    const withNames = assignNames(base).map((n, i) => ({ ...n, side: peers[i]! }));
    return { named: withNames, ...(diagnostic !== undefined && { diagnostic }) };
  }

  return {
    async peers(): Promise<PeersResult> {
      const { named: list, diagnostic } = await named(await side.resolveSelf());
      const notes: string[] = [];

      // Scoping, before the urgent caveat: which sessions this list covers
      // matters more than how they are delivered to, and unlike the urgent
      // note it is emitted for an *empty* list too. An empty peer list with
      // no explanation is exactly what reads as "nothing else is running" on
      // a machine with a dozen live Claude Code sessions.
      if (side.ownKindScope === 'cross-config-dir') {
        const native = NATIVE_PEER_PATH[side.selfRuntime];
        notes.push(
          `${LABEL[side.selfRuntime]} sessions are listed here only when they run under a ` +
            `different CLAUDE_CONFIG_DIR. Your host reaches same-account sessions ` +
            `natively${native !== undefined ? ` (${native})` : ''}, so Tin Can does not ` +
            `duplicate that path.`,
        );
      }

      const nonSteerable = [...new Set(side.peerRuntimes)].filter(
        (r) => !runtimeSupportsUrgent(r),
      );
      if (nonSteerable.length > 0 && list.length > 0) {
        notes.push(
          // LABEL, not the raw RuntimeName tokens: tool-definitions.ts
          // renders "Codex and Claude Code" for the same pair, and two
          // spellings in one tool's output is a bug the reader has to
          // resolve.
          `urgent has no effect for ${labelList(nonSteerable)} peers: ` +
            `${nonSteerable.length > 1 ? 'those runtimes expose' : 'that runtime exposes'} ` +
            `no way to interrupt a running turn, so messages to them are always queued.`,
        );
      }
      return {
        peers: list.map((p) => ({
          name: p.display,
          display_label: slugify(p.rawName ?? '')
            ? p.display
            : `${basename(p.side.cwd) || p.runtime} · ${(p.side.threadId ?? p.uuid).slice(-4).toLowerCase()}`,
          canonical_id: p.canonicalId,
          state: p.side.state,
          cwd: p.side.cwd,
          ...durableIdOf(p.side),
          ...(p.side.configDir !== undefined && { config_dir: p.side.configDir }),
          ...(p.side.canReply !== undefined && { can_reply: p.side.canReply }),
        })),
        ...(diagnostic !== undefined && { diagnostic }),
        ...(notes.length > 0 && { notes }),
      };
    },

    async send_peer(rawArgs: SendPeerArgs): Promise<SendPeerResult> {
      const args = sendPeerSchema.parse(rawArgs);

      // Before resolution, deliberately. A retry under the same key must still
      // answer "already sent" when the peer has exited in the meantime —
      // resolving first would report peer_unreachable, which is true of the
      // peer and false about the message.
      if (args.idempotency_key !== undefined) {
        const prior = idempotency.lookup(args.idempotency_key);
        if (prior !== undefined) {
          const sameCall = prior.peerArg === args.peer && prior.text === args.message;
          return {
            delivered: false,
            refusal: 'duplicate_send',
            // The original id, not a new one: the caller asked about an intent
            // that already has a message, and this is how they find it.
            message_id: prior.messageId,
            detail: sameCall
              ? `Already sent as ${prior.messageId} to ${prior.peer}. Nothing was sent ` +
                `again. Read it in message_log; do not retry under a new key.`
              : `idempotency_key "${args.idempotency_key}" was already used to send ` +
                `${prior.messageId} to ${prior.peer}, and the peer or message differs ` +
                `from that call — so this is a reused key, not a retry. Nothing was ` +
                `sent. Use a new key for a new message.`,
          };
        }
      }

      // One resolution for the whole call: the exclusion in listPeers, the
      // envelope's `from=`, and the wire's `message_from` must all name the
      // same session. See SelfRef.
      const self = await side.resolveSelf();
      const { named: list, diagnostic } = await named(self);

      // Resolved once, here: the self check below, the envelope's `from=` and
      // the wire's `message_from` must not disagree about who we are.
      const selfName = await side.selfName(self);

      const resolved = resolvePeer(list, args.peer, (q) =>
        isSelfAddress(side.selfRuntime, selfName, q),
      );
      if (!resolved.ok) {
        if (resolved.reason === 'self') {
          // A host filters itself out of its own listing, so this would
          // otherwise read as "no such peer" — true, but misleading.
          const alsoMatched =
            resolved.candidates.length > 0
              ? ` If you meant a peer whose name starts the same way, address it in full: ` +
                `${resolved.candidates.join(', ')}.`
              : '';
          return {
            delivered: false,
            refusal: 'self_send',
            ...(resolved.candidates.length > 0 && { candidates: resolved.candidates }),
            detail:
              `"${args.peer}" is this session. You cannot send a message to yourself — ` +
              `Tin Can never lists the session it is running in.${alsoMatched}`,
          };
        }
        return {
          delivered: false,
          refusal: resolved.reason === 'unknown' ? 'peer_unknown' : 'peer_ambiguous',
          candidates: resolved.candidates,
          detail:
            resolved.reason === 'unknown'
              ? `No peer matches "${args.peer}".` +
                (diagnostic !== undefined ? ` ${diagnostic}` : ` Call peers to see what is reachable.`)
              : `"${args.peer}" matches more than one peer. Use the suffixed form.`,
        };
      }

      const target = resolved.peer as NamedPeer & { side: SidePeer };

      // Before the reachability check and before the guard: a name that now
      // answers for a different session is not a delivery problem, and neither
      // "that peer is busy" nor a rate-limit refusal would tell the caller the
      // one thing that matters — that the session it meant is gone. Checking
      // here also means a mismatch costs no guard budget, since no message to
      // this peer was ever intended.
      if (args.expect_id !== undefined) {
        const durable = durableIdOf(target.side);
        const actual = 'thread_id' in durable ? durable.thread_id : durable.session_id;
        if (actual !== args.expect_id) {
          return {
            delivered: false,
            refusal: 'peer_changed',
            peer_state: target.side.state,
            detail:
              `"${args.peer}" now resolves to session ${actual}, not ${args.expect_id} — ` +
              `the session you listed has exited and another has taken its name. Nothing ` +
              `was sent. Call peers again and decide whether this message still applies.`,
          };
        }
      }

      if (target.side.state === 'unreachable') {
        return {
          delivered: false,
          refusal: 'peer_unreachable',
          peer_state: 'unreachable',
          detail: `${target.display} is not accepting input (gone, ephemeral, or a subagent thread).`,
        };
      }

      const guard = guardFor(target.side.runtime);
      const verdict = guard.check(target.canonicalId, args.message);
      if (!verdict.ok) {
        const id = newMessageId();
        log.appendDropped(id, verdict.reason);
        return {
          delivered: false,
          refusal: verdict.reason,
          peer_state: target.side.state,
          message_id: id,
          detail: verdict.detail,
        };
      }

      const envelope = buildEnvelope({
        id: newMessageId(),
        from: { runtime: side.selfRuntime, name: selfName, cwd: side.selfCwd },
        // `!== false`, not `=== true`: only the Claude arm sets the field, and
        // a Codex or opencode peer leaving it undefined must keep today's
        // wording.
        reply_tool: target.side.canReply !== false,
        to: {
          runtime: target.side.runtime,
          name: target.display,
          cwd: target.side.cwd,
          ...(target.side.threadId !== undefined && { thread_id: target.side.threadId }),
        },
        method: methodFor(target.side.runtime),
        expect_reply: args.expect_reply,
        ...(args.in_reply_to !== undefined && { in_reply_to: args.in_reply_to }),
        ...(args.answers && { answers: true }),
        text: args.message,
      });

      // Effective mode, not bare `urgent` intent: 'steer' only when the peer's
      // runtime can actually act on it (opencode today). An urgent send to
      // Codex or Claude Code still queues — recording 'steer' there would be
      // reporting what was asked for, not what happened to the peer's turn.
      const delivery: 'queue' | 'steer' =
        args.urgent && runtimeSupportsUrgent(target.side.runtime) ? 'steer' : 'queue';

      // Log before delivering, so a crash mid-send still leaves a record (§8.6).
      log.appendMessage(envelope, false, delivery);
      guard.record(target.canonicalId, args.message);

      const outcome = await side.deliver(
        self,
        selfName,
        target.side,
        envelope.id,
        renderEnvelope(envelope),
        args.urgent,
      );

      log.appendOutcome(
        envelope.id,
        outcome.delivered,
        outcome.notice ?? (outcome.delivered ? undefined : outcome.error),
      );

      // Only on success. A transient failure must leave the key usable, since
      // retrying under it is exactly what the caller is supposed to do.
      if (args.idempotency_key !== undefined && outcome.delivered) {
        idempotency.record(args.idempotency_key, {
          messageId: envelope.id,
          peer: target.display,
          peerArg: args.peer,
          text: args.message,
        });
      }

      // A peer that is simply gone and a peer whose delivery errored are not
      // the same answer, and a caller branching on `refusal` could not tell
      // them apart while both collapsed to `delivery_failed` (#10). The
      // listing-time check above catches a peer already known to be
      // unreachable; this catches the one that was still listed when we
      // resolved it and had exited by the time we wrote to it.
      const gone = !outcome.delivered && outcome.unreachable === true;
      return {
        delivered: outcome.delivered,
        method: outcome.method,
        peer_state: gone ? 'unreachable' : target.side.state,
        message_id: envelope.id,
        ...(outcome.notice !== undefined && { notice: outcome.notice }),
        ...(!outcome.delivered && {
          refusal: gone ? ('peer_unreachable' as const) : ('delivery_failed' as const),
          detail: gone
            ? `${target.display} stopped accepting input before the message landed` +
              `${outcome.error === undefined ? '' : ` (${outcome.error})`}.`
            : (outcome.error ?? 'The peer runtime did not accept the message.'),
        }),
      };
    },

    async message_log(
      rawArgs: MessageLogArgs,
    ): Promise<{ records: LogRecord[]; integrity?: LogIntegrity }> {
      const args = messageLogSchema.parse(rawArgs);
      const { records, integrity } = log.readWithIntegrity(args);
      // Present only when something is wrong. A field that is always there
      // and almost always says "fine" is a field the reader stops reading,
      // and this one exists to be noticed on the day it matters.
      return { records, ...(integrity.ok ? {} : { integrity }) };
    },
  };
}

/**
 * Does this address name the session Tin Can is running in?
 *
 * Takes the self name already resolved by the caller rather than reading it
 * again: send_peer resolves it once for the envelope's `from=`, and a second
 * read can answer differently (the plugin rewrites the record on events), so
 * the check and the provenance marking would disagree about who we are.
 */
function isSelfAddress(selfRuntime: RuntimeName, selfName: string, query: string): boolean {
  if (query === '') return false;
  const name = selfName.toLowerCase();
  return name === query || name.startsWith(query) || query.startsWith(`${selfRuntime}:${name}`);
}
