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
  const selfName = selfNameFor(runtime, ctx);
  const common = { selfRuntime: runtime, selfCwd: ctx.cwd, supportsUrgent: false };

  if (runtime === 'claude-code') {
    // Hosted in Claude Code, so the peers are Codex threads.
    const codex = createCodexEnv();
    const name = selfNameFor(runtime, ctx);
    return {
      ...common,
      selfName: async () => name,
      peerRuntime: 'codex',
      limits: CODEX_LIMITS,
      async listPeers() {
        const { peers, diagnostic } = await listCodexPeers(codex);
        return {
          peers: peers.map((p) => ({
            rawName: p.rawName,
            uuid: p.uuid,
            cwd: p.cwd,
            state: p.state,
            threadId: p.threadId,
          })),
          ...(diagnostic !== undefined && { diagnostic }),
        };
      },
      async deliver(peer: SidePeer, _id, text): Promise<DeliveryOutcome> {
        const r = await codex.queue(peer.threadId ?? peer.uuid, text);
        return {
          delivered: r.ok,
          method: 'thread/queue/add',
          ...(r.error !== undefined && { error: r.error }),
        };
      },
    };
  }

  // Hosted in Codex, so the peers are Claude Code sessions.
  const codexForSelf = createCodexEnv();
  let resolved: string | undefined;
  return {
    ...common,
    selfName: async () => {
      resolved ??= await codexSelfName(codexForSelf, ctx, env);
      return resolved;
    },
    peerRuntime: 'claude-code',
    limits: CLAUDE_LIMITS,
    async listPeers() {
      const sessions = await listClaudeSessions({
        registryDir: ctx.registryDir,
        selfPid: ctx.pid,
        env,
      });
      if (sessions.length === 0) {
        return {
          peers: [],
          diagnostic:
            'No Claude Code sessions are registered. Start one, or check that ' +
            `${ctx.registryDir} exists.`,
        };
      }
      return {
        peers: sessions.map((s) => ({
          rawName: s.rawName,
          uuid: s.uuid,
          cwd: s.cwd,
          state: s.state,
          socketPath: s.socketPath,
          auth: s.auth,
        })),
      };
    },
    async deliver(peer: SidePeer, id, text): Promise<DeliveryOutcome> {
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
    },
  };
}

/**
 * Codex sets no thread-id variable for MCP servers, so we find the thread whose
 * writer lock our host process holds. Falling back to the directory name is
 * wrong the moment two Codex sessions share a directory.
 */
async function codexSelfName(
  codex: CodexEnv,
  ctx: HostContext,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const fallback = basename(ctx.cwd) || 'codex';
  try {
    const live = await codex.liveThreads();
    const holders = new Map<string, number>();
    for (const [threadId, info] of live) {
      if (info.pid !== undefined) holders.set(threadId, info.pid);
    }
    // Our own pid first: usually tincan is a child of the Codex process, but a
    // host that runs us in-process would hold the lock itself.
    const chain = [ctx.pid, ...(await ancestorPids(ctx.pid, parentPidLookup(env)))];
    const selfThreadId = pickSelfThreadId(holders, chain);
    if (selfThreadId === undefined) return fallback;

    const threads = await codex.listThreads();
    return codexSelfNameOf(threads.find((t) => t.id === selfThreadId)?.name ?? null, ctx.cwd);
  } catch {
    return fallback;
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
