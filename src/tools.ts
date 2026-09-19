/** The three tools (§7), identical on both sides. */
import { z } from 'zod';
import { assignNames, resolvePeer, type NamedPeer, type RuntimeName } from './naming.js';
import { buildEnvelope, newMessageId, renderEnvelope, type DeliveryMethod } from './envelope.js';
import { Guard, type GuardLimits, type GuardReason } from './guard.js';
import { MessageLog, type LogRecord } from './log.js';
import type { PeerState } from './claude/discover.js';

export interface SidePeer {
  rawName: string | null;
  uuid: string;
  cwd: string;
  state: PeerState;
  threadId?: string;
  socketPath?: string;
  auth?: unknown;
}

export interface DeliveryOutcome {
  delivered: boolean;
  method: DeliveryMethod;
  notice?: string;
  error?: string;
  unreachable?: boolean;
}

/** Everything that differs between being hosted in Claude Code and in Codex. */
export interface Side {
  selfRuntime: RuntimeName;
  /** Resolved lazily: the Codex side must derive its own identity at runtime. */
  selfName(): Promise<string>;
  selfCwd: string;
  peerRuntime: RuntimeName;
  limits: GuardLimits;
  /** False where the runtime offers no way to interrupt a running turn. */
  supportsUrgent: boolean;
  listPeers(): Promise<{ peers: SidePeer[]; diagnostic?: string }>;
  deliver(peer: SidePeer, envelopeId: string, text: string, urgent: boolean): Promise<DeliveryOutcome>;
}

export const sendPeerSchema = z.object({
  peer: z.string(),
  message: z.string().min(1),
  in_reply_to: z.string().optional(),
  expect_reply: z.boolean().default(false),
  urgent: z.boolean().default(false),
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
  | 'peer_unreachable'
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
    canonical_id: string;
    state: PeerState;
    cwd: string;
    thread_id?: string;
  }>;
  diagnostic?: string;
  notes?: string[];
}

export function createTools(side: Side, log: MessageLog, guard: Guard) {
  async function named(): Promise<{
    named: Array<NamedPeer & { side: SidePeer }>;
    diagnostic?: string;
  }> {
    const { peers, diagnostic } = await side.listPeers();
    const base = peers.map((p) => ({
      runtime: side.peerRuntime,
      rawName: p.rawName,
      uuid: p.uuid,
    }));
    const withNames = assignNames(base).map((n, i) => ({ ...n, side: peers[i]! }));
    return { named: withNames, ...(diagnostic !== undefined && { diagnostic }) };
  }

  return {
    async peers(): Promise<PeersResult> {
      const { named: list, diagnostic } = await named();
      const notes: string[] = [];
      if (!side.supportsUrgent && list.length > 0) {
        notes.push(
          `urgent has no effect for ${side.peerRuntime} peers: this runtime exposes no way ` +
            `to interrupt a running turn, so every message is queued.`,
        );
      }
      return {
        peers: list.map((p) => ({
          name: p.display,
          canonical_id: p.canonicalId,
          state: p.side.state,
          cwd: p.side.cwd,
          ...(p.side.threadId !== undefined && { thread_id: p.side.threadId }),
        })),
        ...(diagnostic !== undefined && { diagnostic }),
        ...(notes.length > 0 && { notes }),
      };
    },

    async send_peer(rawArgs: SendPeerArgs): Promise<SendPeerResult> {
      const args = sendPeerSchema.parse(rawArgs);
      const { named: list, diagnostic } = await named();

      const resolved = resolvePeer(list, args.peer);
      if (!resolved.ok) {
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
      if (target.side.state === 'unreachable') {
        return {
          delivered: false,
          refusal: 'peer_unreachable',
          peer_state: 'unreachable',
          detail: `${target.display} is not accepting input (gone, ephemeral, or a subagent thread).`,
        };
      }

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
        from: { runtime: side.selfRuntime, name: await side.selfName(), cwd: side.selfCwd },
        to: {
          runtime: side.peerRuntime,
          name: target.display,
          cwd: target.side.cwd,
          ...(target.side.threadId !== undefined && { thread_id: target.side.threadId }),
        },
        method: side.peerRuntime === 'codex' ? 'thread/queue/add' : 'inbox',
        expect_reply: args.expect_reply,
        ...(args.in_reply_to !== undefined && { in_reply_to: args.in_reply_to }),
        text: args.message,
      });

      // Log before delivering, so a crash mid-send still leaves a record (§8.6).
      log.appendMessage(envelope, false);
      guard.record(target.canonicalId, args.message);

      const outcome = await side.deliver(
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

      return {
        delivered: outcome.delivered,
        method: outcome.method,
        peer_state: target.side.state,
        message_id: envelope.id,
        ...(outcome.notice !== undefined && { notice: outcome.notice }),
        ...(!outcome.delivered && {
          refusal: 'delivery_failed' as const,
          detail: outcome.error ?? 'The peer runtime did not accept the message.',
        }),
      };
    },

    async message_log(rawArgs: MessageLogArgs): Promise<{ records: LogRecord[] }> {
      const args = messageLogSchema.parse(rawArgs);
      return { records: log.read(args) };
    },
  };
}
