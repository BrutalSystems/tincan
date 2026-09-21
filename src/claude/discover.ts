/**
 * Claude Code peer discovery.
 *
 * `<config dir>/sessions/<pid>.json` is a live registry the handoff did not
 * know about: it carries name, cwd, sessionId, status and the socket path, so
 * §7's naming and §8.9's state come from the harness rather than from
 * guesswork. The socket is still connect-probed every listing, because the
 * registry can outlive the process that wrote it.
 *
 * There is more than one such directory. CLAUDE_CONFIG_DIR moves it, so a
 * second account's sessions live in a registry the first account's session
 * cannot see — which is why this takes a list, and why each session it returns
 * is tagged with the directory it was found in.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type { InboxAuth } from './client.js';

export type PeerState = 'idle' | 'busy' | 'unreachable';

export interface ClaudeSession {
  pid: number;
  uuid: string;
  rawName: string | null;
  cwd: string;
  state: PeerState;
  socketPath: string;
  configDir: string;
  registryDir: string;
  auth?: InboxAuth;
}

/** Socket directory shapes Claude Code 2.1.267 will bind, in preference order. */
export function socketDirCandidates(env: NodeJS.ProcessEnv, uid: number): string[] {
  const dirs: string[] = [];
  if (env.XDG_RUNTIME_DIR) dirs.push(join(env.XDG_RUNTIME_DIR, 'cc-socks'));
  dirs.push('/tmp/cc-socks', `/tmp/cc-socks-${uid}`);
  return dirs;
}

export interface ListParams {
  /** Our own dir first; then every dir a pointer record names. */
  registryDirs: string[];
  selfPid: number;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  probeMs?: number;
  /** Injected for tests; the live `procStart` of a running pid. */
  liveProcStart?: (pid: number) => string | undefined;
}

export interface ClaudeListing {
  sessions: ClaudeSession[];
  /**
   * Every pid a registry claimed, reachable or not. The sweep subtracts this
   * from the live sockets to find sessions in config dirs nobody named — so
   * an unreachable-but-known session must be in here, or the sweep would
   * rediscover it as a stranger.
   */
  accountedPids: Set<number>;
  diagnostic?: string;
}

/** `ps -o lstart=` prints exactly the format the registry records store. */
function procStartOf(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

interface Candidate {
  registryDir: string;
  rec: Record<string, unknown>;
  pid: number;
}

export async function listClaudeSessions(params: ListParams): Promise<ClaudeListing> {
  const {
    registryDirs,
    selfPid,
    env = process.env,
    uid = process.getuid?.() ?? 0,
    liveProcStart = procStartOf,
  } = params;

  // Collect first, resolve collisions second. A pid in two registries cannot
  // be judged until both have been seen.
  const byPid = new Map<number, Candidate[]>();
  for (const registryDir of registryDirs) {
    if (!existsSync(registryDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(registryDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of entries) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(readFileSync(join(registryDir, file), 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pid = typeof rec.pid === 'number' ? rec.pid : Number(file.replace('.json', ''));
      if (pid === selfPid) continue;
      const list = byPid.get(pid) ?? [];
      list.push({ registryDir, rec, pid });
      byPid.set(pid, list);
    }
  }

  const accountedPids = new Set<number>(byPid.keys());
  const ambiguous: number[] = [];
  const chosen: Candidate[] = [];

  for (const [pid, candidates] of byPid) {
    if (candidates.length === 1) {
      const only = candidates[0];
      if (only !== undefined) chosen.push(only);
      continue;
    }
    // Two registries claim one pid; at most one can be the running process.
    // Sending with the loser's token would authenticate as a dead session.
    const live = liveProcStart(pid);
    const matches = live === undefined ? [] : candidates.filter((c) => c.rec.procStart === live);
    if (matches.length === 1) {
      const winner = matches[0];
      if (winner !== undefined) chosen.push(winner);
    } else {
      ambiguous.push(pid);
    }
  }

  const sessions: ClaudeSession[] = [];
  for (const { registryDir, rec, pid } of chosen) {
    const socketPath =
      typeof rec.messagingSocketPath === 'string'
        ? rec.messagingSocketPath
        : findSocket(pid, env, uid);
    if (socketPath === undefined) continue;

    const live = await probeSocket(socketPath, params.probeMs ?? 1500);
    const auth = readAuth(registryDir, pid);
    sessions.push({
      pid,
      uuid: String(rec.sessionId ?? ''),
      rawName: typeof rec.name === 'string' && rec.name !== '' ? rec.name : null,
      cwd: String(rec.cwd ?? ''),
      state: live ? mapState(rec.status) : 'unreachable',
      socketPath,
      registryDir,
      configDir: dirname(registryDir),
      ...(auth !== undefined && { auth }),
    });
  }

  const diagnostic =
    ambiguous.length === 0
      ? undefined
      : `Claude Code pid${ambiguous.length > 1 ? 's' : ''} ${ambiguous.join(', ')} ` +
        `appear${ambiguous.length > 1 ? '' : 's'} in more than one config dir and could not be ` +
        `told apart; skipped rather than risk addressing a dead session.`;

  return { sessions, accountedPids, ...(diagnostic !== undefined && { diagnostic }) };
}

/** `waiting` means the session is blocked on its human — not free to answer. */
function mapState(status: unknown): PeerState {
  return status === 'idle' ? 'idle' : 'busy';
}

function findSocket(pid: number, env: NodeJS.ProcessEnv, uid: number): string | undefined {
  for (const dir of socketDirCandidates(env, uid)) {
    const p = join(dir, `${pid}.sock`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function readAuth(registryDir: string, pid: number): InboxAuth | undefined {
  const key = readdirSync(registryDir).find((f) =>
    new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`).test(f),
  );
  if (key === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(registryDir, key), 'utf8'));
    return typeof parsed?.peerToken === 'string' ? (parsed as InboxAuth) : undefined;
  } catch {
    return undefined;
  }
}

/** Connect and close: microseconds locally, and the only honest liveness signal. */
export function probeSocket(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const conn = net.createConnection(socketPath);
    conn.on('connect', () => finish(true));
    conn.on('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}
