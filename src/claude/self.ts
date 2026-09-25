/**
 * Who this Tin Can's own Claude Code session is.
 *
 * Tin Can runs as a child of the session, so `process.pid` is never the
 * session's. Two things name it: CLAUDE_CODE_MESSAGING_SOCKET, whose basename
 * is the session pid, and ppid. The socket wins, because it is the session's
 * own statement about itself; ppid is the fallback for a shape we have not
 * seen.
 *
 * Everything here refuses rather than guesses. A missing peer is recoverable;
 * a pointer naming the wrong config dir is not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { VERSION } from '../version.js';
import { pointerDir, writePointer, removePointer, readPointers } from './registry.js';

export interface ClaudeSelf {
  sessionId: string;
  pid: number;
  configDir: string;
  registryDir: string;
  procStart?: string;
  /** The harness-supplied name in the same record, so one read answers both. */
  name?: string;
}

function pidFromSocket(socketPath: string | undefined): number | undefined {
  if (socketPath === undefined) return undefined;
  const m = /^(\d+)\.sock$/.exec(basename(socketPath));
  if (m === null) return undefined;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Which pid the HARNESS is, as distinct from ours. */
export function harnessPid(env: NodeJS.ProcessEnv, ppid: number): number {
  return pidFromSocket(env.CLAUDE_CODE_MESSAGING_SOCKET) ?? ppid;
}

/**
 * Who the harness says we are, right now, read from the record at our own pid.
 *
 * The pid is the key because it is the one thing that cannot drift inside a
 * live process. CLAUDE_CODE_SESSION_ID cannot be trusted for this: it is
 * captured when the MCP server is spawned, and Claude Code REASSIGNS a
 * session's id while the harness process lives, rewriting `<pid>.json` and
 * leaving every already-spawned child holding an id the harness has abandoned.
 *
 * Measured on one machine before this was fixed: 13 of 25 live sessions were
 * in that state, each reported to every peer as unable to reply, because the
 * pointer record had been written under the boot id and nothing matched it.
 * One of them listed ITSELF as a peer, which is the failure with no recovery
 * — self-exclusion is by session id, and it was excluding the wrong one.
 *
 * Returns the whole record's identity, not just the id: the name lives in the
 * same file, and reading it here is what stops `from=` degrading to the
 * working directory's basename the moment the id moves.
 */
export function ownSessionRecord(
  registryDirs: string[],
  env: NodeJS.ProcessEnv,
  ppid: number,
): { pid: number; sessionId: string; name?: string; procStart?: string; registryDir: string } | undefined {
  const pid = harnessPid(env, ppid);
  for (const registryDir of registryDirs) {
    if (!existsSync(registryDir)) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(registryDir, `${pid}.json`), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec.sessionId !== 'string' || rec.sessionId === '') continue;
    return {
      pid,
      sessionId: rec.sessionId,
      registryDir,
      ...(typeof rec.name === 'string' && rec.name !== '' && { name: rec.name }),
      ...(typeof rec.procStart === 'string' && { procStart: rec.procStart }),
    };
  }
  return undefined;
}

export function resolveClaudeSelf(
  env: NodeJS.ProcessEnv,
  ppid: number,
  home: string = homedir(),
): ClaudeSelf | undefined {
  const configDir =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
      ? env.CLAUDE_CONFIG_DIR
      : join(home, '.claude');
  const registryDir = join(configDir, 'sessions');
  if (!existsSync(registryDir)) return undefined;

  // Scoped to OUR config dir, deliberately: the pointer this feeds names a
  // registry dir, and a pointer naming the wrong one is the unrecoverable
  // error this file has always refused rather than guessed at.
  const own = ownSessionRecord([registryDir], env, ppid);
  if (own === undefined) return undefined;

  return {
    sessionId: own.sessionId,
    pid: own.pid,
    configDir,
    registryDir,
    ...(own.procStart !== undefined && { procStart: own.procStart }),
    ...(own.name !== undefined && { name: own.name }),
  };
}

/**
 * Returns the unregister function, so the caller owns teardown and tests do
 * not have to reach into the filesystem to undo it.
 */
export function registerSelf(
  env: NodeJS.ProcessEnv,
  ppid: number,
  home: string = homedir(),
): (() => void) | undefined {
  const sessionId = syncSelfPointer(env, ppid, home);
  if (sessionId === undefined) return undefined;
  const dir = pointerDir(env, home);
  // Re-resolved at teardown rather than closed over: by then the id may have
  // moved again, and removing the id we registered under would leave the
  // current one behind for every peer to keep finding.
  return () => {
    removePointer(dir, resolveClaudeSelf(env, ppid, home)?.sessionId ?? sessionId);
    removePointer(dir, sessionId);
  };
}

/**
 * Make the pointer say what is true now, and return the id it says.
 *
 * Called on every listing, not only at startup, because registering once was
 * the bug: the id the pointer was keyed on is reassigned under a live process,
 * and from that moment the session is invisible as a peer that can reply.
 *
 * The orphan is REMOVED, not merely joined by a correct record. Two pointers
 * at one live pid make one Tin Can look like two sessions, and the stale one
 * reports the version that was running when it was written — which is how a
 * session two releases old appeared to be running an old build.
 *
 * Writes only when something actually changed, so the common case is one small
 * read rather than a temp-and-rename on every call.
 */
export function syncSelfPointer(
  env: NodeJS.ProcessEnv,
  ppid: number,
  home: string = homedir(),
): string | undefined {
  const self = resolveClaudeSelf(env, ppid, home);
  if (self === undefined) return undefined;
  const dir = pointerDir(env, home);

  let current: { sessionId: string; pid: number; tincanVersion: string } | undefined;
  try {
    // Every record, live or not: ours is what we are about to replace, and
    // pruning by liveness would hide the one we need to clean up.
    for (const rec of readPointers(dir, () => true)) {
      if (rec.sessionId === self.sessionId) current = rec;
      // Any other id at our own pid is us, under an identity the harness has
      // since abandoned.
      else if (rec.pid === self.pid) removePointer(dir, rec.sessionId);
    }
  } catch {
    /* an unreadable pointer dir is handled by the write below */
  }

  if (
    current !== undefined &&
    current.pid === self.pid &&
    current.tincanVersion === VERSION
  ) {
    return self.sessionId;
  }

  try {
    writePointer(dir, {
      sessionId: self.sessionId,
      pid: self.pid,
      configDir: self.configDir,
      registryDir: self.registryDir,
      ...(self.procStart !== undefined && { procStart: self.procStart }),
      tincanVersion: VERSION,
      writtenAt: Date.now(),
    });
  } catch {
    // An unwritable ~/.tincan costs discoverability, never the session.
    return undefined;
  }
  return self.sessionId;
}
