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
import { pointerDir, writePointer, removePointer } from './registry.js';

export interface ClaudeSelf {
  sessionId: string;
  pid: number;
  configDir: string;
  registryDir: string;
  procStart?: string;
}

function pidFromSocket(socketPath: string | undefined): number | undefined {
  if (socketPath === undefined) return undefined;
  const m = /^(\d+)\.sock$/.exec(basename(socketPath));
  if (m === null) return undefined;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function resolveClaudeSelf(
  env: NodeJS.ProcessEnv,
  ppid: number,
  home: string = homedir(),
): ClaudeSelf | undefined {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  if (sessionId === undefined || sessionId === '') return undefined;

  const configDir =
    env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
      ? env.CLAUDE_CONFIG_DIR
      : join(home, '.claude');
  const registryDir = join(configDir, 'sessions');
  if (!existsSync(registryDir)) return undefined;

  const pid = pidFromSocket(env.CLAUDE_CODE_MESSAGING_SOCKET) ?? ppid;

  // The validation, and the whole reason this function can return undefined:
  // the dir must hold a record for this pid naming this session.
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(readFileSync(join(registryDir, `${pid}.json`), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (rec.sessionId !== sessionId) return undefined;

  return {
    sessionId,
    pid,
    configDir,
    registryDir,
    ...(typeof rec.procStart === 'string' && { procStart: rec.procStart }),
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
  const self = resolveClaudeSelf(env, ppid, home);
  if (self === undefined) return undefined;

  const dir = pointerDir(env, home);
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
  return () => removePointer(dir, self.sessionId);
}
