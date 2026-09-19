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

export type ThreadRead = { ok: true; source?: string } | { ok: false; error: string };

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
   * Whether the thread store can serve this thread, and what produced it.
   * This is the reachability test — `thread/list` filters by source and so
   * omits reachable threads.
   */
  readThread(threadId: string): Promise<ThreadRead>;
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
  // is a real peer — just not always a reachable one.
  const reasons: string[] = [];
  const peers = await Promise.all(
    [...live.entries()].map(async ([id, info]) => {
      const t = byId.get(id);
      const read = await env.readThread(id);
      const state = reachability(read, t, reasons);
      return {
        uuid: id,
        threadId: id,
        rawName: t?.name ?? null,
        cwd: t?.cwd ?? info.cwd ?? '',
        state,
      };
    }),
  );

  const unique = [...new Set(reasons)];
  if (unique.length > 0) return { peers, diagnostic: unique.join(' ') };
  return { peers };
}

function reachability(
  read: ThreadRead,
  t: CodexThread | undefined,
  reasons: string[],
): PeerState {
  if (!read.ok) {
    reasons.push(
      /rollout/i.test(read.error)
        ? 'A Codex session is open but unreachable until its first turn — a new thread ' +
          'has no rollout to queue against. Send one prompt in that terminal and it ' +
          'becomes addressable.'
        : `A Codex thread could not be read: ${read.error}`,
    );
    return 'unreachable';
  }

  // `codex exec` is fire-once: thread/queue/add succeeds and the text reaches the
  // thread, but the process exits without ever acting on it. Reporting that as
  // delivered would be a lie.
  if (read.source === 'exec') {
    reasons.push(
      'A headless `codex exec` run is live but cannot be messaged — it accepts queued ' +
        'input and exits without reading it. Message an interactive session instead.',
    );
    return 'unreachable';
  }

  if (t !== undefined) return stateOf(t);
  return 'idle';
}

function stateOf(t: CodexThread): PeerState {
  // Ephemeral and subagent threads reject queued input (§5): unreachable, not an error.
  if (t.ephemeral === true || t.canAcceptDirectInput === false) return 'unreachable';

  switch (t.status) {
    case 'active':
      return 'busy';
    case 'systemError':
      return 'unreachable';
    // `notLoaded` describes OUR app-server's view, not the owning process's, so
    // almost every live thread reports it. Treating it as busy told the sender
    // they were interrupting someone when they were not. Codex busy-detection
    // is therefore best-effort — see the README.
    case 'idle':
    case 'notLoaded':
    default:
      return 'idle';
  }
}
