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
  /** Thread ids whose writer lock is held by a running process. */
  liveThreadIds(): Promise<Set<string>>;
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

  const [threads, live] = await Promise.all([env.listThreads(), env.liveThreadIds()]);

  const peers = threads
    .filter((t) => live.has(t.id))
    .map((t) => ({
      uuid: t.id,
      threadId: t.id,
      rawName: t.name,
      cwd: t.cwd,
      state: stateOf(t),
    }));

  return { peers };
}

function stateOf(t: CodexThread): PeerState {
  // Ephemeral and subagent threads reject queued input (§5): unreachable, not an error.
  if (t.ephemeral === true || t.canAcceptDirectInput === false) return 'unreachable';
  return t.status === 'idle' || t.status === undefined ? 'idle' : 'busy';
}
