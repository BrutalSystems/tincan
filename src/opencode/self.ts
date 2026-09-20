/**
 * Which opencode session is hosting us.
 *
 * opencode exports no OPENCODE_SESSION_ID into tool subprocesses, so the
 * environment can only name the *instance* (OPENCODE_PID), never the
 * *session*. The plugin's `tool.execute.before` hook does see the calling
 * sessionID — including for MCP-provided tools — and records it on every Tin
 * Can tool call at `inst-<instance-id>.caller.json`. This module reads that
 * file and matches it against our own OPENCODE_PID.
 *
 * See docs/change-notice-opencode.md §4 and plugins/opencode/SPEC.md §4.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SelfSessionParams {
  registryDir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * `OPENCODE_PID` as a real pid, or `undefined` if it cannot possibly be one.
 *
 * Two traps in one guard:
 * - `env.OPENCODE_PID` is a STRING; the caller file's `pid` is a NUMBER.
 *   `rec.pid === env.OPENCODE_PID` compiles cleanly against
 *   `Record<string, unknown>` and is always false — self would never be
 *   excluded and a self-send would deliver silently. Compare as numbers.
 * - `Number('')` is `0`, and `Number.isInteger(0)` is `true` — an empty or
 *   whitespace `OPENCODE_PID` would otherwise sail through as pid 0. No real
 *   process has pid 0, so a positive-integer check closes it for free.
 *
 * The two call sites (here, and runtime.ts's instance-level fallback) MUST
 * share this function rather than re-deriving it — that duplication is
 * exactly how this guard's tightening in one place failed to reach the other.
 */
export function parseOpencodePid(env: NodeJS.ProcessEnv): number | undefined {
  const pid = Number(env.OPENCODE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The opencode session hosting us, or `undefined` when it cannot be
 * determined — `OPENCODE_PID` absent, empty, or non-numeric, no caller file
 * has been written yet, or it is unreadable/unparseable.
 *
 * Callers MUST treat `undefined` as "fall back to excluding the whole
 * instance," never as "exclude nothing" — see runtime.ts's opencode-hosted
 * `Side`. Under-excluding here risks a self-send; over-excluding a sibling
 * session is merely inconvenient.
 */
export async function selfSessionId(params: SelfSessionParams): Promise<string | undefined> {
  const { registryDir, env } = params;

  const selfPid = parseOpencodePid(env);
  if (selfPid === undefined) return undefined;

  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch {
    return undefined; // Registry directory absent: plugin not installed, or not yet.
  }

  for (const name of names) {
    if (!name.startsWith('inst-') || !name.endsWith('.caller.json')) continue;

    let raw: string;
    try {
      raw = await readFile(join(registryDir, name), 'utf8');
    } catch {
      // The plugin can unlink/rewrite this file between our readdir and our
      // readFile (dispose, orphan sweep, a concurrent tool call). Not an
      // error — try the next candidate.
      continue;
    }

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (rec.pid === selfPid && typeof rec.session_id === 'string' && rec.session_id.length > 0) {
      return rec.session_id;
    }
  }

  return undefined;
}
