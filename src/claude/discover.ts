/**
 * Claude Code peer discovery.
 *
 * `~/.claude/sessions/<pid>.json` is a live registry the handoff did not know
 * about: it carries name, cwd, sessionId, status and the socket path, so §7's
 * naming and §8.9's state come from the harness rather than from guesswork.
 * The socket is still connect-probed every listing, because the registry can
 * outlive the process that wrote it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
  registryDir: string;
  selfPid: number;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  probeMs?: number;
}

export async function listClaudeSessions(params: ListParams): Promise<ClaudeSession[]> {
  const { registryDir, selfPid, env = process.env, uid = process.getuid?.() ?? 0 } = params;
  if (!existsSync(registryDir)) return [];

  const entries = readdirSync(registryDir).filter((f) => /^\d+\.json$/.test(f));
  const sessions: ClaudeSession[] = [];

  for (const file of entries) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(registryDir, file), 'utf8'));
    } catch {
      continue;
    }

    const pid = typeof rec.pid === 'number' ? rec.pid : Number(file.replace('.json', ''));
    if (pid === selfPid) continue;

    const socketPath =
      typeof rec.messagingSocketPath === 'string'
        ? rec.messagingSocketPath
        : findSocket(pid, env, uid);
    if (socketPath === undefined) continue;

    const live = await probe(socketPath, params.probeMs ?? 1500);
    const auth = readAuth(registryDir, pid);
    sessions.push({
      pid,
      uuid: String(rec.sessionId ?? ''),
      rawName: typeof rec.name === 'string' && rec.name !== '' ? rec.name : null,
      cwd: String(rec.cwd ?? ''),
      state: live ? mapState(rec.status) : 'unreachable',
      socketPath,
      ...(auth !== undefined && { auth }),
    });
  }

  return sessions;
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
function probe(socketPath: string, timeoutMs: number): Promise<boolean> {
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
