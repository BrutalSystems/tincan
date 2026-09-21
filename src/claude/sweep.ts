/**
 * The fallback: find live Claude Code sessions in config dirs nobody named.
 *
 * Detection needs no heuristic. Every session binds <pid>.sock in the shared
 * socket dir, and socketDirCandidates already encodes where that is — an
 * assumption Tin Can has always shipped. Subtract the pids the registries
 * accounted for and what remains is, by construction, a session in a config
 * dir we do not know.
 *
 * Only resolution is platform-specific, and it runs only for that remainder,
 * which is normally empty. When it fails the pid is *reported*, not dropped:
 * "a session I can see but cannot address" is a far better answer than
 * silence.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { socketDirCandidates } from './discover.js';
import type { ConfigDirResolver } from './env.js';

export interface UnresolvedPeer {
  pid: number;
  socketPath: string;
}

export interface SweepResult {
  /** Registry dirs to append to the listing and read like any other. */
  resolvedDirs: string[];
  unresolved: UnresolvedPeer[];
}

export interface SweepParams {
  env: NodeJS.ProcessEnv;
  uid: number;
  accountedPids: Set<number>;
  resolveConfigDir: ConfigDirResolver;
  isLive?: (pid: number) => boolean;
  /**
   * Test seam. Production always takes socketDirCandidates, which always
   * includes the real /tmp/cc-socks — so without this a test on a machine
   * with live sessions sweeps them for real.
   */
  socketDirs?: string[];
}

function defaultIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sweepUnaccounted(params: SweepParams): SweepResult {
  const {
    env,
    uid,
    accountedPids,
    resolveConfigDir,
    isLive = defaultIsLive,
    socketDirs = socketDirCandidates(env, uid),
  } = params;

  const resolvedDirs: string[] = [];
  const seenDirs = new Set<string>();
  const unresolved: UnresolvedPeer[] = [];
  const seenPids = new Set<number>();

  for (const dir of socketDirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = /^(\d+)\.sock$/.exec(name);
      if (m === null) continue;
      const pid = Number(m[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (accountedPids.has(pid) || seenPids.has(pid)) continue;
      seenPids.add(pid);
      // A socket file outlives the process that bound it. Checking liveness
      // before resolving also keeps the resolver off dead pids entirely.
      if (!isLive(pid)) continue;

      const configDir = resolveConfigDir(pid);
      if (configDir === undefined || configDir === '') {
        unresolved.push({ pid, socketPath: join(dir, name) });
        continue;
      }
      const registryDir = join(configDir, 'sessions');
      if (seenDirs.has(registryDir)) continue;
      seenDirs.add(registryDir);
      resolvedDirs.push(registryDir);
    }
  }

  return { resolvedDirs, unresolved };
}

/** Exported for the caller that needs a config dir back out of a registry dir. */
export function configDirOf(registryDir: string): string {
  return dirname(registryDir);
}
