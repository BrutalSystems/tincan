import { execFile } from 'node:child_process';
import { basename } from 'node:path';

/**
 * Which opencode process hosts us, when opencode does not say.
 *
 * opencode 1.x sets `OPENCODE` and `OPENCODE_PID` in the environment of every
 * MCP server it starts, and both `detectRuntime` and self-resolution
 * (`self.ts`) are keyed on them. opencode 2.x sets neither [verified 2.0.24:
 * the server's environment carries no OPENCODE* variable at all]. Without them
 * a Tin Can under 2.x detects `codex` — or `claude-code`, when the background
 * service was started from a Claude Code terminal and inherited its
 * environment — and every message it sends names the wrong sender, so a reply
 * cannot find its way back.
 *
 * The process tree still knows. 2.x starts MCP servers from its background
 * service, and that service's pid is exactly the `pid` the plugin stamps on
 * every registry record and caller ticket [verified]. So when the variables
 * are missing, walk up from our parent: the first `opencode` ancestor is the
 * host, and supplying the two variables 1.x would have set makes every
 * downstream path work unchanged.
 */

export interface ProcessInfo {
  ppid: number;
  command: string;
}
export type DescribeProcess = (pid: number) => Promise<ProcessInfo | undefined>;

/** Far enough for `npx` → npm → node → tincan, and bounded against a cycle. */
const MAX_DEPTH = 6;

/** Harnesses that stop the walk: a nearer one is our host, not opencode. */
const OTHER_HARNESSES = new Set(['claude', 'codex']);

/** `ps` is on macOS and Linux; anywhere it is not, this answers undefined. */
export function describeProcess(pid: number): Promise<ProcessInfo | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 1000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout.split('\n')[0] ?? '');
      resolve(m ? { ppid: Number(m[1]), command: m[2] as string } : undefined);
    });
  });
}

export async function withOpencodeHost(
  env: NodeJS.ProcessEnv,
  startPid: number,
  describe: DescribeProcess = describeProcess,
): Promise<NodeJS.ProcessEnv> {
  if (env.OPENCODE || env.OPENCODE_PID) return env;
  let pid = startPid;
  try {
    for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
      const info = await describe(pid);
      if (info === undefined) return env;
      const name = basename(info.command);
      if (name === 'opencode') return { ...env, OPENCODE: '1', OPENCODE_PID: String(pid) };
      if (OTHER_HARNESSES.has(name)) return env;
      if (info.ppid === pid) return env;
      pid = info.ppid;
    }
  } catch {
    // Not knowing is the old behaviour, never a reason to fail startup.
  }
  return env;
}
