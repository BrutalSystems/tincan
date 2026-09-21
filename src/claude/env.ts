/**
 * Resolve a live pid to the CLAUDE_CONFIG_DIR it was started with.
 *
 * This is the only platform-specific file in Tin Can, and the only place that
 * reads another process's environment. It runs solely for pids the registries
 * could not account for — normally none.
 *
 * A process environment is full of secrets that are none of Tin Can's
 * business. Exactly one variable is extracted; the buffer is never returned,
 * logged, or put in a diagnostic.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type ConfigDirResolver = (pid: number) => string | undefined;

const NAME = 'CLAUDE_CONFIG_DIR';

/**
 * `ps -E` prints the environment space-separated, so a path containing a
 * space is only delimitable by the *next* VAR= that follows it. Hence the
 * lookahead rather than \S+, which would truncate "/Users/x/My Configs/cc".
 */
export function parseConfigDirFromPsLine(line: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${NAME}=(.*?)(?=\\s+[A-Za-z_][A-Za-z0-9_]*=|$)`).exec(line);
  const value = m?.[1];
  return value === undefined || value === '' ? undefined : value;
}

export function parseConfigDirFromProcEnviron(buf: string): string | undefined {
  for (const entry of buf.split('\0')) {
    if (!entry.startsWith(`${NAME}=`)) continue;
    const value = entry.slice(NAME.length + 1);
    return value === '' ? undefined : value;
  }
  return undefined;
}

export const resolveConfigDirFromProcess: ConfigDirResolver = (pid) => {
  if (process.platform === 'linux') {
    try {
      return parseConfigDirFromProcEnviron(readFileSync(`/proc/${pid}/environ`, 'utf8'));
    } catch {
      return undefined;
    }
  }
  try {
    // -ww: insurance, not a fix for anything observed. Plain and -ww output
    // were byte-identical when measured, but macOS ps has historically
    // truncated wide output and the flag costs nothing.
    const out = execFileSync('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseConfigDirFromPsLine(out);
  } catch {
    return undefined;
  }
};
