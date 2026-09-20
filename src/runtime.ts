/**
 * Which harness is hosting us, and what the opposite side looks like.
 * Not a config flag (§4): the environment already answers it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { assertNever, slugify, type RuntimeName } from './naming.js';
import { CLAUDE_LIMITS, CODEX_LIMITS, OPENCODE_LIMITS } from './guard.js';
import type { Side, SidePeer, DeliveryOutcome } from './tools.js';
import { listClaudeSessions } from './claude/discover.js';
import { sendToInbox, type InboxAuth } from './claude/client.js';
import { listCodexPeers, type CodexEnv } from './codex/discover.js';
import { createCodexEnv, parentPidLookup } from './codex/cli.js';
import { pickSelfThreadId, ancestorPids } from './codex/self.js';
import { listOpencodeSessions, type OpencodeSession } from './opencode/discover.js';
import { sendToInstance } from './opencode/client.js';
import { selfSessionId, parseOpencodePid } from './opencode/self.js';
import { runtimeSupportsUrgent } from './tools.js';

export interface HostContext {
  registryDir: string;
  pid: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function claudeRegistryDir(home: string = homedir()): string {
  return join(home, '.claude', 'sessions');
}

/** Mirrors the plugin's peersDir. Keep these two in step. */
export function opencodeRegistryDir(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const base = env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
  return join(base, 'peers', 'opencode');
}

export function detectRuntime(env: NodeJS.ProcessEnv): RuntimeName {
  // OPENCODE first, deliberately. An MCP subprocess inherits the environment of
  // whatever launched opencode, so CLAUDE_CODE_MESSAGING_SOCKET can be present
  // at the same time — verified with a stub MCP server. Checking Claude first
  // makes an opencode-hosted instance misidentify its own host.
  if (env.OPENCODE || env.OPENCODE_PID) return 'opencode';
  if (env.CLAUDE_CODE_MESSAGING_SOCKET) return 'claude-code';
  return 'codex';
}

export function selfNameFor(runtime: RuntimeName, ctx: HostContext): string {
  if (runtime === 'claude-code') {
    // tincan runs as a child of the session, so our pid is not the session's.
    // CLAUDE_CODE_SESSION_ID identifies the host exactly; pid is the fallback.
    const sessionId = (ctx.env ?? process.env).CLAUDE_CODE_SESSION_ID;
    const name = findSessionName(ctx.registryDir, sessionId, ctx.pid);
    if (name !== undefined) return name;
  }
  return basename(ctx.cwd) || runtime;
}

function findSessionName(
  registryDir: string,
  sessionId: string | undefined,
  pid: number,
): string | undefined {
  if (!existsSync(registryDir)) return undefined;
  for (const file of readdirSync(registryDir).filter((f) => /^\d+\.json$/.test(f))) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(registryDir, file), 'utf8'));
    } catch {
      continue;
    }
    const matches =
      (sessionId !== undefined && rec.sessionId === sessionId) || rec.pid === pid;
    if (matches && typeof rec.name === 'string' && rec.name !== '') return rec.name;
  }
  return undefined;
}

export function buildSide(runtime: RuntimeName, ctx: HostContext): Side {
  const env = ctx.env ?? process.env;
  const common = { selfRuntime: runtime, selfCwd: ctx.cwd };

  switch (runtime) {
    case 'claude-code': {
      // Hosted in Claude Code, so the peers are Codex threads and opencode
      // sessions. (Claude Code's own sessions are reached natively via
      // SendMessage, so Tin Can deliberately does not duplicate that path.)
      const codex = createCodexEnv();
      const name = selfNameFor(runtime, ctx);
      const registryDir = opencodeRegistryDir(env);
      const peerRuntimes: RuntimeName[] = ['codex', 'opencode'];
      return {
        ...common,
        selfName: async () => name,
        peerRuntimes,
        supportsUrgent: peerRuntimes.some(runtimeSupportsUrgent),
        limitsFor,
        async listPeers() {
          const [codexListing, opencodeListing] = await Promise.all([
            listCodexPeers(codex),
            listOpencodeSessions({ registryDir }),
          ]);
          const peers = [
            ...codexListing.peers.map(toCodexSidePeer),
            ...opencodeListing.peers.map(toOpencodeSidePeer),
          ];
          const diagnostic =
            peers.length === 0
              ? (opencodeListing.diagnostic ?? codexListing.diagnostic)
              : codexListing.diagnostic;
          return {
            peers,
            ...(diagnostic !== undefined && { diagnostic }),
          };
        },
        deliver: (peer, id, text, urgent) =>
          deliverTo(codex, ctx, peer, id, text, urgent, async () => name),
      };
    }

    case 'opencode': {
      // opencode has no native peer messaging of any kind (change notice §4),
      // so unlike the Claude Code host this side lists all three runtimes —
      // including its own. That means a Tin Can instance hosted here must
      // exclude itself from among its opencode siblings too, not merely from
      // Codex/Claude Code.
      const registryDir = opencodeRegistryDir(env);
      const codexForOpencode = createCodexEnv();
      const peerRuntimes: RuntimeName[] = ['codex', 'claude-code', 'opencode'];

      // Deliberately NOT cached across calls: the caller file is scoped to
      // the opencode *instance*, and one instance can run several sessions
      // that each call a Tin Can tool through the same shared MCP subprocess
      // (SPEC §4). Caching the first answer would freeze "self" to whichever
      // session happened to call first, misidentifying every later caller.
      const resolveSelfSession = () => selfSessionId({ registryDir, env });

      return {
        ...common,
        selfName: () => opencodeSelfName(registryDir, resolveSelfSession, ctx.cwd),
        peerRuntimes,
        supportsUrgent: peerRuntimes.some(runtimeSupportsUrgent),
        limitsFor,

        async listPeers() {
          const [codexListing, claudeSessions, opencodeListing, selfSession] = await Promise.all([
            listCodexPeers(codexForOpencode),
            listClaudeSessions({ registryDir: ctx.registryDir, selfPid: ctx.pid, env }),
            listOpencodeSessions({ registryDir }),
            resolveSelfSession(),
          ]);

          const codexPeers = codexListing.peers.map(toCodexSidePeer);
          const claudePeers: SidePeer[] = claudeSessions.map((session) => ({
            runtime: 'claude-code',
            rawName: session.rawName,
            uuid: session.uuid,
            cwd: session.cwd,
            state: session.state,
            socketPath: session.socketPath,
            auth: session.auth,
          }));

          // Self-exclusion (change notice §4, corrected by the probe). When
          // the caller file names our exact session, exclude only it — a
          // sibling session in the same instance stays addressable, which is
          // the entire reason the caller file exists rather than just keying
          // off OPENCODE_PID. When it does not (missing or unreadable caller
          // file), fall back to excluding every session of our own
          // instance: over-excluding a sibling is safe, under-excluding
          // risks a self-send delivering to ourselves.
          // Shared with self.ts's own guard (parseOpencodePid) rather than
          // re-derived here — a duplicated `Number(env.OPENCODE_PID)` is
          // exactly how the positive-integer check (Number('') is 0, and
          // Number.isInteger(0) is true) got fixed in one copy and not the
          // other.
          const selfPid = parseOpencodePid(env);
          const opencodePeers = opencodeListing.peers
            .filter((s) => {
              if (selfSession !== undefined) return s.uuid !== selfSession;
              if (selfPid !== undefined) return s.pid !== selfPid;
              // We cannot identify ourselves at all — OPENCODE_PID itself is
              // missing or unparseable, so there is no pid to key the
              // instance-level fallback on either. Exclude every opencode
              // session rather than risk a self-send: over-excluding here is
              // safe, listing ourselves is not.
              return false;
            })
            .map(toOpencodeSidePeer);

          const peers = [...codexPeers, ...claudePeers, ...opencodePeers];
          if (peers.length === 0) {
            return {
              peers,
              diagnostic:
                opencodeListing.diagnostic ??
                codexListing.diagnostic ??
                'No other agent sessions are running. Start a Codex, Claude Code, or ' +
                  'opencode session.',
            };
          }
          return {
            peers,
            ...(codexListing.diagnostic !== undefined && { diagnostic: codexListing.diagnostic }),
          };
        },

        deliver: (peer, id, text, urgent) =>
          deliverTo(codexForOpencode, ctx, peer, id, text, urgent, () =>
            opencodeSelfName(registryDir, resolveSelfSession, ctx.cwd),
          ),
      };
    }

    case 'codex': {
      // Hosted in Codex. Codex's own collaboration.list_agents / send_message
      // are scoped to a spawn tree ("live agents in the current root thread
      // tree") and cannot reach an independently launched session, so Tin Can
      // exposes BOTH Codex and Claude peers here. The asymmetry with the
      // Claude side is deliberate — see the README.
      const codexForSelf = createCodexEnv();
      let selfThread: string | undefined;
      const selfName = makeSelfNameResolver(
        () => codexThreadName(codexForSelf, ctx, env),
        ctx.cwd,
      );
      const peerRuntimes: RuntimeName[] = ['codex', 'claude-code'];

      return {
        ...common,
        selfName,
        peerRuntimes,
        supportsUrgent: peerRuntimes.some(runtimeSupportsUrgent),
        limitsFor,

        async listPeers() {
          selfThread ??= await selfThreadId_(codexForSelf, ctx, env);

          const [codexListing, claudeSessions] = await Promise.all([
            listCodexPeers(codexForSelf),
            listClaudeSessions({ registryDir: ctx.registryDir, selfPid: ctx.pid, env }),
          ]);

          const codexPeers = codexListing.peers
            .filter((p) => p.threadId !== selfThread) // never list ourselves
            .map(toCodexSidePeer);

          const claudePeers: SidePeer[] = claudeSessions.map((session) => ({
            runtime: 'claude-code',
            rawName: session.rawName,
            uuid: session.uuid,
            cwd: session.cwd,
            state: session.state,
            socketPath: session.socketPath,
            auth: session.auth,
          }));

          const peers = [...codexPeers, ...claudePeers];
          if (peers.length === 0) {
            return {
              peers,
              diagnostic:
                'No other agent sessions are running. Start a Codex or Claude Code ' +
                'session, or check that it has taken its first turn.',
            };
          }
          return {
            peers,
            ...(codexListing.diagnostic !== undefined && { diagnostic: codexListing.diagnostic }),
          };
        },

        deliver: (peer, id, text, urgent) =>
          deliverTo(codexForSelf, ctx, peer, id, text, urgent, selfName),
      };
    }

    default:
      return assertNever(runtime, 'buildSide');
  }
}

export function limitsFor(runtime: RuntimeName) {
  switch (runtime) {
    case 'codex':
      return CODEX_LIMITS;
    case 'claude-code':
      return CLAUDE_LIMITS;
    case 'opencode':
      return OPENCODE_LIMITS;
    default:
      return assertNever(runtime, 'limitsFor');
  }
}

function toCodexSidePeer(p: {
  rawName: string | null;
  uuid: string;
  cwd: string;
  state: ReturnType<typeof String> extends never ? never : SidePeer['state'];
  threadId: string;
}): SidePeer {
  return {
    runtime: 'codex',
    rawName: p.rawName,
    uuid: p.uuid,
    cwd: p.cwd,
    state: p.state,
    threadId: p.threadId,
  };
}

function toOpencodeSidePeer(p: OpencodeSession): SidePeer {
  return {
    runtime: 'opencode',
    rawName: p.rawName,
    uuid: p.uuid,
    cwd: p.cwd,
    state: p.state,
    socketPath: p.socketPath,
  };
}

/**
 * Delivery dispatches on the peer's runtime, not on the host's.
 *
 * `urgent` must reach every branch that can act on it. It is threaded through
 * explicitly here — rather than folded into a closure captured elsewhere —
 * because an arrow with fewer parameters than `Side.deliver`'s declared type
 * is assignable to it with no compiler error (see runtime.test.ts and
 * tools.test.ts's end-to-end `urgent` tests). `selfName` is only needed for
 * the opencode wire, which is the one that carries a sender field explicitly.
 */
async function deliverTo(
  codex: CodexEnv,
  ctx: HostContext,
  peer: SidePeer,
  id: string,
  text: string,
  urgent: boolean,
  selfName: () => Promise<string>,
): Promise<DeliveryOutcome> {
  switch (peer.runtime) {
    case 'codex': {
      const r = await codex.queue(peer.threadId ?? peer.uuid, text);
      return {
        delivered: r.ok,
        method: 'thread/queue/add',
        ...(r.error !== undefined && { error: r.error }),
      };
    }
    case 'claude-code': {
      const r = await sendToInbox({
        socketPath: peer.socketPath!,
        auth: peer.auth as InboxAuth | undefined,
        text,
        msgId: id,
      });
      return {
        delivered: r.delivered,
        method: 'inbox',
        ...(r.notice !== undefined && { notice: r.notice }),
        ...(r.error !== undefined && { error: r.error }),
        ...(r.unreachable !== undefined && { unreachable: r.unreachable }),
      };
    }
    case 'opencode': {
      const r = await sendToInstance({
        socketPath: peer.socketPath!,
        toSession: peer.uuid,
        from: await selfName(),
        text,
        // opencode's own default is "steer"; Tin Can's policy is queue-by-
        // default (SPEC §7 / change-notice-opencode.md §3). This field must
        // always be set explicitly — never leave it to inherit opencode's
        // default, which would silently invert the policy.
        delivery: urgent ? 'steer' : 'queue',
        messageId: id,
      });
      return {
        delivered: r.delivered,
        method: 'opencode/prompt',
        ...(r.error !== undefined && { error: r.error }),
        ...(r.unreachable !== undefined && { unreachable: r.unreachable }),
      };
    }
    default:
      return assertNever(peer.runtime, 'deliverTo');
  }
}

/**
 * Our own slug: peers address us by whatever `slug` our own `ses_*.json`
 * advertises (I6), not by our working directory's basename. `isSelfAddress`
 * (tools.ts) compares a typed address against exactly this value, so getting
 * it wrong means a self-send typed as our slug is never recognised as self —
 * it either returns a misleading `peer_unknown`, or, when the caller file is
 * absent, is not excluded at all and delivers.
 *
 * Falls back to the directory name, the same as every other host, whenever a
 * session cannot be resolved or its record has no slug.
 */
async function opencodeSelfName(
  registryDir: string,
  resolveSelfSession: () => Promise<string | undefined>,
  cwd: string,
): Promise<string> {
  const sessionId = await resolveSelfSession();
  const slug = sessionId === undefined ? undefined : readOpencodeSlug(registryDir, sessionId);
  return slug ?? (basename(cwd) || 'opencode');
}

function readOpencodeSlug(registryDir: string, sessionId: string): string | undefined {
  const path = join(registryDir, `${sessionId}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof rec.slug === 'string' && rec.slug.length > 0 ? rec.slug : undefined;
  } catch {
    return undefined;
  }
}

/** Our own Codex thread, so a Codex-hosted instance never lists itself. */
async function selfThreadId_(
  codex: CodexEnv,
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const live = await codex.liveThreads();
    const holders = new Map<string, number>();
    for (const [threadId, info] of live) {
      if (info.pid !== undefined) holders.set(threadId, info.pid);
    }
    const chain = [ctx.pid, ...(await ancestorPids(ctx.pid, parentPidLookup(env)))];
    return pickSelfThreadId(holders, chain);
  } catch {
    return undefined;
  }
}

/**
 * Caches only a real answer. A Codex thread has no title until its first turn,
 * but the MCP server starts before that and resolves its own name for the
 * startup diagnostic — caching that fallback left a session calling itself by
 * its directory for the rest of its life.
 */
export function makeSelfNameResolver(
  resolve: () => Promise<string | undefined>,
  cwd: string,
): () => Promise<string> {
  let cached: string | undefined;
  return async () => {
    if (cached !== undefined) return cached;
    const name = await resolve();
    if (name === undefined || name === '') return basename(cwd) || 'codex';
    cached = name;
    return cached;
  };
}

/**
 * The slugified title of the Codex thread hosting us, or undefined if it does
 * not have one yet. Undefined rather than a fallback, so the caller can decide
 * whether the answer is worth caching.
 */
async function codexThreadName(
  codex: CodexEnv,
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const id = await selfThreadId_(codex, ctx, env);
    if (id === undefined) return undefined;
    const threads = await codex.listThreads();
    const raw = threads.find((t) => t.id === id)?.name;
    const slug = raw === undefined || raw === null ? '' : slugify(raw);
    return slug === '' ? undefined : slug;
  } catch {
    return undefined;
  }
}


/**
 * The name a Codex-hosted tincan puts in `from=`. Slugified, because that is
 * what a peer types back into send_peer.
 */
export function codexSelfNameOf(threadName: string | null, cwd: string): string {
  const slug = threadName === null ? '' : slugify(threadName);
  return slug !== '' ? slug : basename(cwd) || 'codex';
}
