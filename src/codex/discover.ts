/**
 * Codex peer discovery.
 *
 * codex-cli 0.155.1 has no app-server control socket on this machine and
 * `thread/loaded/list` only ever reports threads loaded in the *calling*
 * process, so it is useless from outside. `thread/list` reads the shared state
 * DB and does report real names, cwd, status and `canAcceptDirectInput`; a
 * thread is "live" when some process holds its writer lock.
 */
import type { PeerState } from '../claude/discover.js';

export interface CodexThread {
  id: string;
  name: string | null;
  cwd: string;
  status?: string;
  ephemeral?: boolean;
  canAcceptDirectInput?: boolean;
}

export interface LiveThreadInfo {
  /** Working directory of the process holding the lock, when we can read it. */
  cwd?: string;
  /** Pid holding the lock — how a Codex-hosted tincan identifies its own thread. */
  pid?: number;
}

export interface CodexPeer {
  uuid: string;
  threadId: string;
  rawName: string | null;
  cwd: string;
  state: PeerState;
}

export interface CodexEnv {
  /** Is a usable `codex` reachable at all? */
  probe(): Promise<{ ok: boolean; diagnostic?: string }>;
  listThreads(): Promise<CodexThread[]>;
  /**
   * Threads whose writer lock is held by a running process, with whatever the
   * holder can tell us. This — not `thread/list` — is the liveness signal.
   */
  liveThreads(): Promise<Map<string, LiveThreadInfo>>;
  queue(threadId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

export interface CodexListing {
  peers: CodexPeer[];
  diagnostic?: string;
}

export async function listCodexPeers(env: CodexEnv): Promise<CodexListing> {
  const probe = await env.probe();
  if (!probe.ok) {
    return {
      peers: [],
      diagnostic:
        probe.diagnostic ??
        'Codex is not reachable. Install or unshadow the `codex` CLI, then retry.',
    };
  }

  const [threads, live] = await Promise.all([env.listThreads(), env.liveThreads()]);
  const byId = new Map(threads.map((t) => [t.id, t]));

  // Union, not intersection: a thread reaches thread/list only after its first
  // turn, but it holds its writer lock from launch. A freshly started session
  // is a real peer — just not yet a reachable one.
  const peers = [...live.entries()].map(([id, info]) => {
    const t = byId.get(id);
    return {
      uuid: id,
      threadId: id,
      rawName: t?.name ?? null,
      cwd: t?.cwd ?? info.cwd ?? '',
      // No thread/list entry means no persisted rollout, and thread/queue/add
      // fails with "no rollout found". One turn in that session fixes it.
      state: t === undefined ? ('unreachable' as const) : stateOf(t),
    };
  });

  const pending = peers.filter((p) => !byId.has(p.threadId));
  if (pending.length > 0) {
    return {
      peers,
      diagnostic:
        `${pending.length} Codex session(s) are open but unreachable until their first turn — ` +
        `a new thread has no rollout to queue against. Send one prompt in that terminal ` +
        `and it becomes addressable.`,
    };
  }

  return { peers };
}

function stateOf(t: CodexThread): PeerState {
  // Ephemeral and subagent threads reject queued input (§5): unreachable, not an error.
  if (t.ephemeral === true || t.canAcceptDirectInput === false) return 'unreachable';
  return t.status === 'idle' || t.status === undefined ? 'idle' : 'busy';
}
