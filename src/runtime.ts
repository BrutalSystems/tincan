/**
 * Which harness is hosting us, and what the opposite side looks like.
 * Not a config flag (§4): the environment already answers it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { slugify, type RuntimeName } from './naming.js';
import { CLAUDE_LIMITS, CODEX_LIMITS } from './guard.js';
import type { Side, SidePeer, DeliveryOutcome } from './tools.js';
import { listClaudeSessions } from './claude/discover.js';
import { sendToInbox, type InboxAuth } from './claude/client.js';
import { listCodexPeers, type CodexEnv } from './codex/discover.js';
import { createCodexEnv, parentPidLookup } from './codex/cli.js';
import { pickSelfThreadId, ancestorPids } from './codex/self.js';

export interface HostContext {
  registryDir: string;
  pid: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function claudeRegistryDir(home: string = homedir()): string {
  return join(home, '.claude', 'sessions');
}

export function detectRuntime(env: NodeJS.ProcessEnv): RuntimeName {
  return env.CLAUDE_CODE_MESSAGING_SOCKET ? 'claude-code' : 'codex';
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
  const common = { selfRuntime: runtime, selfCwd: ctx.cwd, supportsUrgent: false };

  if (runtime === 'claude-code') {
    // Hosted in Claude Code, so the peers are Codex threads.
    const codex = createCodexEnv();
    const name = selfNameFor(runtime, ctx);
    return {
      ...common,
      selfName: async () => name,
      peerRuntimes: ['codex'],
      limitsFor,
      async listPeers() {
        // Claude Code reaches its own sessions natively via SendMessage, so
        // Tin Can deliberately does not duplicate that path.
        const { peers, diagnostic } = await listCodexPeers(codex);
        return {
          peers: peers.map(toCodexSidePeer),
          ...(diagnostic !== undefined && { diagnostic }),
        };
      },
      deliver: (peer, id, text) => deliverTo(codex, ctx, peer, id, text),
    };
  }

  // Hosted in Codex. Codex's own collaboration.list_agents / send_message are
  // scoped to a spawn tree ("live agents in the current root thread tree") and
  // cannot reach an independently launched session, so Tin Can exposes BOTH
  // Codex and Claude peers here. The asymmetry with the Claude side is
  // deliberate — see the README.
  const codexForSelf = createCodexEnv();
  let selfThread: string | undefined;
  const selfName = makeSelfNameResolver(
    () => codexThreadName(codexForSelf, ctx, env),
    ctx.cwd,
  );

  return {
    ...common,
    selfName,
    peerRuntimes: ['codex', 'claude-code'],
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

    deliver: (peer, id, text) => deliverTo(codexForSelf, ctx, peer, id, text),
  };
}

function limitsFor(runtime: RuntimeName) {
  return runtime === 'codex' ? CODEX_LIMITS : CLAUDE_LIMITS;
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

/** Delivery dispatches on the peer's runtime, not on the host's. */
async function deliverTo(
  codex: CodexEnv,
  ctx: HostContext,
  peer: SidePeer,
  id: string,
  text: string,
): Promise<DeliveryOutcome> {
  if (peer.runtime === 'codex') {
    const r = await codex.queue(peer.threadId ?? peer.uuid, text);
    return {
      delivered: r.ok,
      method: 'thread/queue/add',
      ...(r.error !== undefined && { error: r.error }),
    };
  }

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
