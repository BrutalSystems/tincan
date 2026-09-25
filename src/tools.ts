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
import {
  buildEnvelope,
  newMessageId,
  newBroadcastId,
  renderEnvelope,
  type DeliveryMethod,
} from './envelope.js';
import { Guard, type GuardLimits, type GuardReason } from './guard.js';
import { MessageLog, type LogRecord, type LogIntegrity } from './log.js';
import { IdempotencyStore, IDEMPOTENCY_WINDOW_MS } from './idempotency.js';
import { VERSION } from './version.js';
import type { PeerState } from './claude/discover.js';

export interface SidePeer {
  /** The peer's own runtime. A peer list may hold more than one. */
  runtime: RuntimeName;
  rawName: string | null;
  uuid: string;
  cwd: string;
  state: PeerState;
  /** Claude Code only (#32): `state` is a safe default, not a reading. */
  statusUnreadable?: boolean;
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
  /**
   * The Tin Can version this peer's pointer record says it is running, or
   * absent when it wrote no pointer. Reported so a peer's version can be read
   * without asking it — which is most of the cost of triaging a bug report.
   */
  tincanVersion?: string;
}

/**
 * What `reregister` answers. Reports the id it now holds rather than just
 * "done", because the whole point is that the caller could not see which id it
 * was registered under in the first place.
 */
export interface ReregisterResult {
  registered: boolean;
  session_id?: string;
  /** Slugified, so it is the name peers will see and type back. */
  name?: string;
  tincan_version: string;
  /** Present only when a drifted registration was actually replaced. */
  previous_session_id?: string;
  detail: string;
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

/**
 * Everything that differs between being hosted in Claude Code and in Codex.
 *
 * There is deliberately no "how much of my own kind do I list" member. There
 * was one — `OwnKindScope` — for as long as the Claude arm listed its own
 * sessions only from other config dirs. Every side now lists its own kind in
 * full, so `peerRuntimes` says everything there is to say and the peer list
 * needs no footnote explaining who is missing from it.
 */
export interface Side {
  selfRuntime: RuntimeName;
  /**
   * Answer "which session is calling?" exactly once per tool call. The result
   * is passed back into `selfName`, `listPeers` and `deliver` so all three
   * agree with each other.
   */
  resolveSelf(): Promise<SelfRef>;
  /**
   * Our OWN durable id, for the envelope's `from`. Optional because not every
   * arm can always answer — a Codex host with no thread yet, for instance —
   * and an absent id must stay absent rather than be invented.
   *
   * This is what lets a receiver route a reply by identity instead of by a
   * display name that can be renamed out from under it.
   */
  selfDurableId?(self: SelfRef): Promise<{ thread_id: string } | { session_id: string } | undefined>;
  /** Resolved lazily: the Codex side must derive its own identity at runtime. */
  selfName(self: SelfRef): Promise<string>;
  /**
   * Claude Code only: force our registration to match the live harness record.
   * Absent on the runtimes that keep no such record.
   */
  reregister?(): Promise<ReregisterResult>;
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

/**
 * The widest fan-out `send_peer` accepts.
 *
 * Capped deliberately. Fan-out makes it trivially easy to exhaust a peer's
 * budget — Codex and opencode allow 3 sends/minute — and a width limit is
 * cheap insurance that also says what this is for: a machine's worth of
 * sessions, not a mailing list.
 *
 * A constant rather than a literal because the number is stated twice: zod
 * ENFORCES it here, and `tool-definitions.ts` ADVERTISES it as `maxItems` to
 * the model. Those were separate literals, and nothing made them agree.
 */
export const MAX_FANOUT = 8;

/**
 * The longest shelf life `replay_for_minutes` will accept, in minutes (#24).
 *
 * Capped for the reason {@link MAX_FANOUT} is: a bound that also states what
 * the feature is for. An instruction to an agent goes stale fast — a day is
 * already generous — and an uncapped duration would let "leave this for them"
 * mean "forever", which is the harm catch-up was scoped to avoid, readmitted
 * through the opt-in door.
 */
export const MAX_REPLAY_MINUTES = 24 * 60;

export const sendPeerSchema = z
  .object({
    peer: z.string().optional(),
    peers: z.array(z.string()).min(1).max(MAX_FANOUT).optional(),
    message: z.string().min(1),
    in_reply_to: z.string().optional(),
    expect_reply: z.boolean().default(false),
    answers: z.boolean().default(false),
    urgent: z.boolean().default(false),
    idempotency_key: z.string().min(1).optional(),
    expect_id: z.string().min(1).optional(),
    replay_for_minutes: z.number().int().positive().max(MAX_REPLAY_MINUTES).optional(),
  })
  .refine((d) => (d.peer === undefined) !== (d.peers === undefined), {
    message: 'Give exactly one of `peer` (one recipient) or `peers` (several).',
  })
  .refine((d) => !(d.expect_id !== undefined && d.peers !== undefined), {
    message: '`expect_id` pins a single session, so it cannot be used with `peers`.',
  });

/**
 * How many records `message_log` returns when the caller does not say.
 *
 * Stated twice like {@link MAX_FANOUT}: applied here by zod, and advertised as
 * the parameter's `default` in the schema the model reads.
 */
export const DEFAULT_LAST_N = 20;

export const messageLogSchema = z.object({
  all_projects: z.boolean().default(false),
  peer: z.string().optional(),
  thread: z.string().optional(),
  last_n: z.number().int().positive().default(DEFAULT_LAST_N),
  missed: z.boolean().default(false),
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
  // in_reply_to names a message this recipient did not send. A reply that
  // lands on an unrelated session is worse than one that is refused.
  | 'reply_misrouted'
  // A key the caller has already used. Distinct from every other refusal
  // because nothing is wrong: the message was sent, and `message_id` names it.
  | 'duplicate_send'
  | GuardReason
  | 'delivery_failed';

/**
 * What happened to a send, at the coarseness a caller acts on.
 *
 * `rejected` means Tin Can refused before sending — the caller did something
 * that needs fixing, and retrying unchanged will fail the same way.
 * `failed` means it was attempted and the peer or transport did not take it;
 * nothing the caller did is wrong, and later may work. That distinction was
 * the one `delivered: false` destroyed.
 */
export type Outcome = 'accepted' | 'rejected' | 'failed';

/** One recipient's outcome within a fan-out. */
export interface FanOutResult {
  peer: string;
  outcome: Outcome;
  message_id?: string;
  method?: DeliveryMethod;
  refusal?: Refusal;
  detail?: string;
  notice?: string;
}

export interface SendPeerResult {
  /** Absent for a fan-out, which reports per recipient plus counts instead. */
  outcome?: Outcome;
  /** Fan-out only: how many were addressed, and how many the harness took. */
  requested?: number;
  accepted?: number;
  broadcast_id?: string;
  results?: FanOutResult[];
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
    /**
     * #32. Present only when Tin Can could not read this peer's published
     * status, so `state` is the safe default (`busy`) rather than a reading.
     * Treat the peer as busy either way — that is what makes this additive
     * rather than a fourth `PeerState` every consumer would have to handle.
     */
    status_unreadable?: boolean;
    cwd: string;
    thread_id?: string;
    session_id?: string;
    /** Claude Code peers only: which account's config dir this session is in. */
    config_dir?: string;
    /** Claude Code peers only: false when the peer has no Tin Can to answer with. */
    can_reply?: boolean;
    /**
     * The Tin Can version this peer's own pointer record claims, or absent
     * when it wrote none. `'unknown'` for a record written by a Tin Can too
     * old to have recorded it — which is itself an answer, and a different one
     * from the field being missing.
     */
    tincan_version?: string;
  }>;
  /** The Tin Can serving this call. Always present. */
  tincan_version: string;
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

      // No scoping note. There was one for as long as the Claude arm listed
      // its own kind only from other config dirs: an empty list that does not
      // say it is scoped reads as "nothing else is running" on a machine with
      // a dozen live sessions. The list is no longer scoped, so the note
      // would now be the thing that misleads.
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
        /**
         * The version of the Tin Can serving THIS call — not whatever `tincan
         * --version` finds on PATH.
         *
         * A session had no way to answer "which Tin Can is running here" from
         * its tools: VERSION reached MCP serverInfo, `--version` and the
         * stderr startup line, and the model can read none of the three.
         * Shelling out answers a different question, because a long-lived
         * session keeps serving the build it started with while HEAD moves on.
         */
        tincan_version: VERSION,
        peers: list.map((p) => ({
          name: p.display,
          display_label: slugify(p.rawName ?? '')
            ? p.display
            : `${basename(p.side.cwd) || p.runtime} · ${(p.side.threadId ?? p.uuid).slice(-4).toLowerCase()}`,
          canonical_id: p.canonicalId,
          state: p.side.state,
          // Additive, and absent unless it applies: `state` stays the whole
          // answer for every consumer that switches on it.
          ...(p.side.statusUnreadable === true && { status_unreadable: true }),
          cwd: p.side.cwd,
          ...durableIdOf(p.side),
          ...(p.side.configDir !== undefined && { config_dir: p.side.configDir }),
          ...(p.side.canReply !== undefined && { can_reply: p.side.canReply }),
          ...(p.side.tincanVersion !== undefined && { tincan_version: p.side.tincanVersion }),
        })),
        ...(diagnostic !== undefined && { diagnostic }),
        ...(notes.length > 0 && { notes }),
      };
    },

    async reregister(): Promise<ReregisterResult> {
      if (side.reregister === undefined) {
        return {
          registered: false,
          tincan_version: VERSION,
          detail:
            `Nothing to reregister: only a Claude Code session publishes a registration ` +
            `record, and this session is hosted in ${LABEL[side.selfRuntime]}. Peers here ` +
            `are discovered live, so there is no stale key to repair.`,
        };
      }
      return side.reregister();
    },

    async send_peer(rawArgs: SendPeerArgs): Promise<SendPeerResult> {
      const args = sendPeerSchema.parse(rawArgs);
      // One code path for both shapes. A separate fan-out branch would be a
      // second place for the resolution and guard rules to drift.
      const addresses = args.peers ?? [args.peer as string];
      const fanOut = args.peers !== undefined;

      // Before resolution, deliberately. A retry under the same key must still
      // answer "already sent" when the peer has exited in the meantime —
      // resolving first would report peer_unreachable, which is true of the
      // peer and false about the message.
      if (args.idempotency_key !== undefined) {
        const prior = idempotency.lookup(args.idempotency_key);
        if (prior !== undefined) {
          const sameCall = prior.peerArg === addresses.join(', ') && prior.text === args.message;
          return {
            outcome: 'rejected',
            ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
            refusal: 'duplicate_send',
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
      const selfName = await side.selfName(self);
      // Resolved once per call, beside the name, so the two cannot disagree
      // about who we are.
      const selfId = (await side.selfDurableId?.(self)) ?? undefined;

      /**
       * Record a send that never became a message (#23, #24).
       *
       * Only for the address that actually caused the refusal. On a fan-out
       * nothing goes to anyone, but the other recipients were reachable and
       * were not tried — writing "someone tried to reach you" against them
       * would put a message in their backlog that nobody was prevented from
       * sending.
       */
      /**
       * Who this attempt was MEANT for, by durable id, where that is knowable.
       *
       * `expect_id` first: it is the caller's own statement of who they meant,
       * and it is the only identity available on the path that matters most —
       * `peer_unknown`, where nothing resolved because the session is gone.
       * A resolved peer answers for the other two refusals.
       *
       * Undefined means the send named a peer only by a name that no longer
       * resolves, which is exactly the identity `expect_id` exists to distrust.
       * Such an attempt is recorded but never replayed.
       */
      const intendedId = (resolvedFor?: SidePeer): string | undefined => {
        if (args.expect_id !== undefined) return args.expect_id;
        if (resolvedFor === undefined) return undefined;
        const durable = durableIdOf(resolvedFor);
        return 'thread_id' in durable ? durable.thread_id : durable.session_id;
      };

      const recordUnsent = (address: string, reason: Refusal, resolvedFor?: SidePeer): string => {
        const id = newMessageId();
        const toId = intendedId(resolvedFor);
        // Both or neither: a shelf life with nobody to deliver to cannot be
        // acted on, and it would read as a promise the log cannot keep.
        const replay =
          args.replay_for_minutes !== undefined && toId !== undefined
            ? {
                until: new Date(Date.now() + args.replay_for_minutes * 60_000).toISOString(),
                toId,
              }
            : undefined;
        log.appendUnsent(
          id,
          { runtime: side.selfRuntime, name: selfName, cwd: side.selfCwd, ...(selfId ?? {}) },
          address,
          reason,
          args.message,
          replay,
        );
        return id;
      };

      // Every address is resolved before anything is delivered, and ANY
      // failure refuses the whole call.
      //
      // The split that governs this function: a failure Tin Can can see coming
      // is all-or-nothing, because a message cannot be un-sent and a caller who
      // reads `delivered` without reading `detail` would otherwise believe
      // three peers know something only two were told. A failure that happens
      // after the point of no return is reported per recipient, because by then
      // honesty is the only option left.
      const targets: Array<NamedPeer & { side: SidePeer }> = [];
      for (const address of addresses) {
        const resolved = resolvePeer(list, address, (q) =>
          isSelfAddress(side.selfRuntime, selfName, q),
        );
        if (!resolved.ok) {
          if (resolved.reason === 'self') {
            const alsoMatched =
              resolved.candidates.length > 0
                ? ` If you meant a peer whose name starts the same way, address it in full: ` +
                  `${resolved.candidates.join(', ')}.`
                : '';
            return {
              outcome: 'rejected',
              ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
              refusal: 'self_send',
              ...(resolved.candidates.length > 0 && { candidates: resolved.candidates }),
              detail:
                `"${address}" is this session. You cannot send a message to yourself — ` +
                `Tin Can never lists the session it is running in.${alsoMatched}`,
            };
          }
          // Replying is the case where an arbitrary candidate is most
          // tempting and most wrong. Observed live: a reply-to name went
          // stale, the refusal listed every peer on the machine, and the
          // model picked one and sent the reply to a stranger. So when this
          // is a reply, the listing is withheld and the guidance names the
          // only correct move.
          const replying = args.in_reply_to !== undefined;
          return {
            outcome: 'rejected',
            ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
            ...(replying ? {} : { candidates: resolved.candidates }),
            // Ambiguity is a caller mistake with every candidate present and
            // listed; nobody was unreachable, so there is no attempt to
            // record. `unknown` is the one that may mean "that session is
            // gone", which is exactly what a returning session looks for.
            ...(resolved.reason === 'unknown'
              ? { message_id: recordUnsent(address, 'peer_unknown') }
              : {}),
            refusal: resolved.reason === 'unknown' ? 'peer_unknown' : 'peer_ambiguous',
            detail:
              resolved.reason === 'unknown'
                ? `No peer matches "${address}".` +
                  (fanOut ? ` Nothing was sent to anyone.` : '') +
                  (replying
                    ? ` You are replying to ${args.in_reply_to}, so this must go to whoever ` +
                      `sent that message and nobody else. Do not send it to a different ` +
                      `session from the peers list. Call peers and match the sender's ` +
                      `thread_id or session_id; if that session is gone, say so instead ` +
                      `of redirecting the reply.`
                    : diagnostic !== undefined
                      ? ` ${diagnostic}`
                      : ` Call peers to see what is reachable.`) +
                  // A shelf life with no way to say who it was for is a silent
                  // no-op: the sender believes the message is waiting for
                  // someone, and nothing will ever be replayed.
                  (args.replay_for_minutes !== undefined && args.expect_id === undefined
                    ? ` It will NOT be replayed: replay_for_minutes needs expect_id to say ` +
                      `which session the message was for, and the name "${address}" no longer ` +
                      `resolves to one.`
                    : '')
                : `"${address}" matches more than one peer. Use the suffixed form.` +
                  (fanOut ? ` Nothing was sent to anyone.` : ''),
          };
        }
        targets.push(resolved.peer as NamedPeer & { side: SidePeer });
      }

      // A reply must reach whoever sent the message it answers. `in_reply_to`
      // was an unvalidated string, so a reply could be addressed to anyone —
      // and was. The original sender's own record is in this machine-global
      // log, so the check is a lookup.
      if (args.in_reply_to !== undefined) {
        const original = log.findMessage(args.in_reply_to);
        if (original !== undefined) {
          const senderId = original.from.thread_id ?? original.from.session_id;
          const matches = targets.some((t) => {
            if (senderId !== undefined) {
              const durable = durableIdOf(t.side);
              const id = 'thread_id' in durable ? durable.thread_id : durable.session_id;
              return id === senderId;
            }
            // Older records carry no sender id; the name is all there is.
            return t.display.toLowerCase() === original.from.name.toLowerCase();
          });
          if (!matches) {
            return {
              outcome: 'rejected',
              ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
              refusal: 'reply_misrouted',
              detail:
                `${args.in_reply_to} was sent by ${original.from.name}` +
                `${senderId === undefined ? '' : ` (${senderId})`}, not by ` +
                `${targets.map((t) => t.display).join(', ')}. Nothing was sent. Reply to ` +
                `the sender, or drop in_reply_to if this is a new message rather than an ` +
                `answer.`,
            };
          }
        }
        // Not found: it rotated out, or predates this log. Cannot check, so
        // do not refuse — see findMessage.
      }

      if (args.expect_id !== undefined) {
        const only = targets[0]!;
        const durable = durableIdOf(only.side);
        const actual = 'thread_id' in durable ? durable.thread_id : durable.session_id;
        if (actual !== args.expect_id) {
          return {
            outcome: 'rejected',
            ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
            refusal: 'peer_changed',
            // The session the caller meant is gone — someone tried to reach
            // it and could not, which is the case #24 is about.
            message_id: recordUnsent(only.display, 'peer_changed', only.side),
            peer_state: only.side.state,
            detail:
              `"${addresses[0]}" now resolves to session ${actual}, not ${args.expect_id} — ` +
              `the session you listed has exited and another has taken its name. Nothing ` +
              `was sent. Call peers again and decide whether this message still applies.`,
          };
        }
      }

      const gone = targets.find((t) => t.side.state === 'unreachable');
      if (gone !== undefined) {
        return {
          outcome: 'rejected',
          ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
          refusal: 'peer_unreachable',
          message_id: recordUnsent(gone.display, 'peer_unreachable', gone.side),
          peer_state: 'unreachable',
          detail:
            `${gone.display} is not accepting input (gone, ephemeral, or a subagent thread).` +
            (fanOut ? ` Nothing was sent to anyone.` : ''),
        };
      }

      // Checked for every recipient before any is recorded: a guard refusal is
      // knowable in advance, so it refuses the whole call rather than leaving a
      // fan-out half delivered.
      for (const t of targets) {
        const verdict = guardFor(t.side.runtime).check(t.canonicalId, args.message);
        if (!verdict.ok) {
          const id = newMessageId();
          log.appendDropped(id, verdict.reason);
          return {
            outcome: 'rejected',
            ...(fanOut && { requested: addresses.length, accepted: 0, results: [] }),
            refusal: verdict.reason,
            peer_state: t.side.state,
            message_id: id,
            detail: verdict.detail + (fanOut ? ` Nothing was sent to anyone.` : ''),
          };
        }
      }

      const broadcastId = fanOut && targets.length > 1 ? newBroadcastId() : undefined;
      const results: FanOutResult[] = [];

      // Sequential, in the order given: the log stays deterministic and a
      // fan-out cannot stampede three harnesses at once.
      for (const target of targets) {
        const others = targets.filter((t) => t !== target).map((t) => t.display);
        const envelope = buildEnvelope({
          id: newMessageId(),
          from: {
            runtime: side.selfRuntime,
            name: selfName,
            cwd: side.selfCwd,
            // Spread, not two optional fields: the arm returns whichever key
            // its runtime uses, and neither is invented when it returns
            // nothing.
            ...(selfId ?? {}),
          },
          // `!== false`, not `=== true`: only the Claude arm sets the field, and
          // a Codex or opencode peer leaving it undefined must keep today's
          // wording.
          reply_tool: target.side.canReply !== false,
          to: {
            runtime: target.side.runtime,
            name: target.display,
            cwd: target.side.cwd,
            // Ask which key this runtime's durable id uses, rather than
            // hardcoding Codex's. `thread_id` alone meant a Claude Code or
            // opencode recipient was recorded by display name only — the name
            // that goes stale, and the one thing `expect_id` refuses to trust.
            ...durableIdOf(target.side),
          },
          method: methodFor(target.side.runtime),
          expect_reply: args.expect_reply,
          ...(args.in_reply_to !== undefined && { in_reply_to: args.in_reply_to }),
          ...(args.answers && { answers: true }),
          ...(others.length > 0 && { also_sent_to: others }),
          ...(broadcastId !== undefined && { broadcast_id: broadcastId }),
          text: args.message,
        });

        const delivery: 'queue' | 'steer' =
          args.urgent && runtimeSupportsUrgent(target.side.runtime) ? 'steer' : 'queue';

        // Log before delivering, so a crash mid-send still leaves a record (§8.6).
        log.appendMessage(envelope, false, delivery);
        guardFor(target.side.runtime).record(target.canonicalId, args.message);

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

        const vanished = !outcome.delivered && outcome.unreachable === true;
        results.push({
          peer: target.display,
          outcome: outcome.delivered ? 'accepted' : 'failed',
          message_id: envelope.id,
          ...(outcome.method !== undefined && { method: outcome.method }),
          ...(outcome.notice !== undefined && { notice: outcome.notice }),
          ...(!outcome.delivered && {
            refusal: vanished ? ('peer_unreachable' as const) : ('delivery_failed' as const),
            detail: vanished
              ? `${target.display} stopped accepting input before the message landed` +
                `${outcome.error === undefined ? '' : ` (${outcome.error})`}.`
              : (outcome.error ?? 'The peer runtime did not accept the message.'),
          }),
        });
      }

      const landed = results.filter((r) => r.outcome === 'accepted');
      if (args.idempotency_key !== undefined && landed.length > 0) {
        idempotency.record(args.idempotency_key, {
          messageId: landed[0]!.message_id!,
          peer: landed.map((r) => r.peer).join(', '),
          peerArg: addresses.join(', '),
          text: args.message,
        });
      }

      if (fanOut) {
        return {
          requested: targets.length,
          accepted: landed.length,
          ...(broadcastId !== undefined && { broadcast_id: broadcastId }),
          results,
        };
      }

      // Byte-identical to what a single-peer caller has always received.
      const only = results[0]!;
      return {
        outcome: only.outcome,
        ...(only.method !== undefined && { method: only.method }),
        peer_state: only.refusal === 'peer_unreachable' ? 'unreachable' : targets[0]!.side.state,
        message_id: only.message_id,
        ...(only.notice !== undefined && { notice: only.notice }),
        ...(only.refusal !== undefined && { refusal: only.refusal, detail: only.detail }),
      };
    },
    async message_log(
      rawArgs: MessageLogArgs,
    ): Promise<{ records: LogRecord[]; integrity?: LogIntegrity; scope_note?: string }> {
      const args = messageLogSchema.parse(rawArgs);

      // #24. Matching is by durable id alone: a session that cannot name its
      // own is not handed a backlog matched on anything weaker, because the
      // weaker thing is the display name, and a restarted session answering to
      // its predecessor's name would collect its predecessor's mail.
      let missed: { toId: string; now: number } | undefined;
      if (args.missed) {
        const durable = await side.selfDurableId?.(await side.resolveSelf());
        const toId =
          durable === undefined
            ? undefined
            : 'thread_id' in durable
              ? durable.thread_id
              : durable.session_id;
        if (toId === undefined) {
          return {
            records: [],
            scope_note:
              `This session cannot resolve its own durable id, so nothing can be matched ` +
              `to it. Attempts left for it are in the log but are not shown here rather ` +
              `than matched on a display name, which is what goes stale across a restart.`,
          };
        }
        missed = { toId, now: Date.now() };
      }

      // `missed` is dropped from the spread deliberately: it is a boolean here
      // and a resolved {toId, now} in ReadQuery, and spreading `false` into a
      // field the reader tests with `!== undefined` turns every ordinary read
      // into a filter that matches nothing.
      const { missed: _asked, ...query } = args;
      const { records: all, integrity } = log.readWithIntegrity({
        ...query,
        ...(missed !== undefined && { missed }),
      });

      // Scoped by default. The log is machine-global, so without this a
      // session asking "what have I been told" is handed every conversation
      // on the machine, including projects it has nothing to do with.
      //
      // Either end matching, not just the sender: peers in different projects
      // messaging each other is much of the point, and such a message belongs
      // in both scopes.
      const here = side.selfCwd.replace(/\/+$/, '');
      const mine = (r: LogRecord): boolean => {
        if (!('from' in r) || !('to' in r)) return true; // notices, drops, checkpoints
        const ends = [r.from.cwd, r.to.cwd].map((c) => (c ?? '').replace(/\/+$/, ''));
        return ends.includes(here);
      };
      const records = args.all_projects ? all : all.filter(mine);

      // A session whose cwd does not match what was recorded — a symlinked
      // path, a moved checkout — would otherwise see an empty log and
      // conclude nothing had ever been sent. Silence is the one answer this
      // must not give.
      const hidden = all.length - records.length;
      const scope_note =
        !args.all_projects && hidden > 0
          ? `Scoped to ${here}; ${hidden} record(s) from other projects on this machine ` +
            `are not shown. Pass all_projects: true for the whole machine.`
          : undefined;
      // Present only when something is wrong. A field that is always there
      // and almost always says "fine" is a field the reader stops reading,
      // and this one exists to be noticed on the day it matters.
      // Also when the log is healthy but rotated: `rotated` is not a fault, and
      // gating on `ok` alone would compute the notice and then drop it,
      // leaving a caller with a short log and nothing to explain it.
      const worthSaying = !integrity.ok || integrity.rotated !== undefined;
      return {
        records,
        ...(worthSaying ? { integrity } : {}),
        ...(scope_note !== undefined && { scope_note }),
      };
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
