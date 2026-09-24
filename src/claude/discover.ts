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
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type { InboxAuth } from './client.js';

/**
 * Every state `peers` can report, in the order the tool description lists them.
 *
 * An array rather than a bare union because the vocabulary is stated twice:
 * here, and in the `peers` description the model reads at connect time. That
 * description used to spell the three out by hand, so adding a state — #32
 * proposes `unknown` — would have left the model told about three of four.
 */
export const PEER_STATES = ['idle', 'busy', 'unreachable'] as const;

export type PeerState = (typeof PEER_STATES)[number];

export interface ClaudeSession {
  pid: number;
  uuid: string;
  rawName: string | null;
  cwd: string;
  state: PeerState;
  /**
   * #32: `state` here is a safe default rather than a reading — the published
   * status was absent, malformed, or a value this version has never heard of.
   * Absent whenever the status was understood. See {@link peerStateFrom}.
   */
  statusUnreadable?: boolean;
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

/**
 * Canonical form for dedupe. realpath, not resolve: resolve only normalises
 * text, so one directory reachable by two paths — a symlinked home, /tmp
 * versus /private/tmp — would dedupe as two. Falls back to the textual form
 * for a path that does not exist, which the caller drops anyway.
 */
export function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** First occurrence wins, so "our own dir first" survives. */
export function dedupeDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = canonicalDir(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
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
  // Deduped here as well as by the caller: the sweep can resolve a stranger
  // into a directory the caller already knew — after "no override means the
  // default dir", that is the common case, not the rare one — and scanning
  // one directory twice makes every session in it look like it appears in two
  // config dirs.
  const byPid = new Map<number, Candidate[]>();
  for (const registryDir of dedupeDirs(registryDirs)) {
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
    // Two records for one pid that name the SAME session are one session seen
    // twice, not a conflict. Only a genuinely different sessionId is a
    // collision. An empty sessionId proves nothing, so it never collapses.
    const ids = new Set(candidates.map((c) => String(c.rec.sessionId ?? '')));
    if (ids.size === 1 && !ids.has('')) {
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
    const status = peerStateFrom(rec.status);
    const auth = readAuth(registryDir, pid);
    sessions.push({
      pid,
      uuid: String(rec.sessionId ?? ''),
      rawName: typeof rec.name === 'string' && rec.name !== '' ? rec.name : null,
      cwd: String(rec.cwd ?? ''),
      ...(live
        ? { state: status.state, ...(status.unreadable && { statusUnreadable: true as const }) }
        : { state: 'unreachable' as const }),
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

/**
 * Read Claude Code's published session status (#32).
 *
 * `waiting` means the session is blocked on its human — not free to answer, so
 * it maps to busy along with everything else that is not `idle`.
 *
 * `unreadable` is the part worth having. Defaulting to busy is the right SAFE
 * choice — assuming a peer is occupied beats assuming it is free — but it made
 * "we do not know" indistinguishable from "we know it is busy". This says
 * which one it is WITHOUT widening `PeerState`: the enum is a published
 * contract that Muster consumes, its safe default is already correct, and
 * adding a fourth value would make every consumer handle it only to arrive at
 * the same behaviour.
 *
 * This file is Claude Code's, not Tin Can's, and it is undocumented. Every
 * field is read as absent-by-default and nothing here may throw: a shape
 * change must never break peer listing.
 */
export function peerStateFrom(status: unknown): { state: PeerState; unreadable: boolean } {
  if (status === 'idle') return { state: 'idle', unreadable: false };
  // The statuses this version knows about. Anything else — missing,
  // malformed, or introduced by a later Claude Code — is still reported busy,
  // but no longer as if it had been understood.
  if (status === 'busy' || status === 'waiting') return { state: 'busy', unreadable: false };
  return { state: 'busy', unreadable: true };
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
