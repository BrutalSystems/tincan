/**
 * The pointer record: how one Tin Can tells every other Tin Can on this
 * machine which Claude Code config dir it is living in.
 *
 * It is deliberately a *pointer*, not a copy. Name, cwd, status and the peer
 * token stay in the harness registry it names, read live on every listing.
 * A stale pointer therefore names a directory whose sessions are probed as
 * they always were; a stale copy would have conjured a phantom peer.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface PointerRecord {
  sessionId: string;
  pid: number;
  configDir: string;
  registryDir: string;
  procStart?: string;
  tincanVersion: string;
  writtenAt: number;
}

/** Mirrors opencodeRegistryDir's shape. Keep the two in step. */
export function pointerDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const base = env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
  return join(base, 'peers', 'claude-code');
}

function defaultIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `basename` because a session id is interpolated into a path: a crafted
 * '../../x' would otherwise name a file outside the registry. The same guard
 * opencode/self.ts applies for the same reason.
 */
function recordPath(dir: string, sessionId: string): string {
  return join(dir, `${basename(sessionId)}.json`);
}

/**
 * Temp-then-rename: a reader must never see half a record.
 *
 * The mode on mkdirSync applies only when the directory is created — an
 * existing ~/.tincan/peers is left exactly as it is, deliberately. Issue #12
 * is what chasing directory permissions on every write looks like when the
 * chmod throws, and the records themselves are 0600, so nothing is exposed by
 * leaving a parent alone.
 */
export function writePointer(dir: string, rec: PointerRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = recordPath(dir, rec.sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, target);
}

export function removePointer(dir: string, sessionId: string): void {
  try {
    unlinkSync(recordPath(dir, sessionId));
  } catch {
    /* never written, already gone, or the directory vanished */
  }
}

function parse(raw: string): PointerRecord | undefined {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof rec.sessionId !== 'string' || rec.sessionId === '') return undefined;
  if (typeof rec.pid !== 'number') return undefined;
  if (typeof rec.configDir !== 'string' || rec.configDir === '') return undefined;
  if (typeof rec.registryDir !== 'string' || rec.registryDir === '') return undefined;
  return {
    sessionId: rec.sessionId,
    pid: rec.pid,
    configDir: rec.configDir,
    registryDir: rec.registryDir,
    ...(typeof rec.procStart === 'string' && { procStart: rec.procStart }),
    tincanVersion: typeof rec.tincanVersion === 'string' ? rec.tincanVersion : 'unknown',
    writtenAt: typeof rec.writtenAt === 'number' ? rec.writtenAt : 0,
  };
}

/**
 * Pruning is by liveness alone. Whether the named registryDir still exists is
 * the caller's problem, because a dir that vanished and a dir we cannot read
 * are the same thing to discovery and it already drops both.
 */
export function readPointers(dir: string, isLive: (pid: number) => boolean = defaultIsLive): PointerRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PointerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const rec = parse(raw);
    if (rec === undefined) continue;
    if (!isLive(rec.pid)) continue;
    out.push(rec);
  }
  return out;
}
