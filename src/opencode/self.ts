/**
 * Which opencode session is hosting us.
 *
 * opencode exports no OPENCODE_SESSION_ID into tool subprocesses, so the
 * environment can only name the *instance* (OPENCODE_PID), never the
 * *session*. The plugin's tool hooks do see the calling sessionID — including
 * for MCP-provided tools — and record it in two places, both matched here
 * against our own OPENCODE_PID:
 *
 * - `inst-<instance-id>.<call-id>.call.json`, one per Tin Can call in flight.
 *   Preferred, because it identifies the caller rather than ranking guesses.
 * - `inst-<instance-id>.caller.json`, one per instance, overwritten by
 *   whichever session called last. The fallback, and the older plugin's only
 *   signal.
 *
 * See docs/change-notice-opencode.md §4 and plugins/opencode/SPEC.md §4.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SelfSessionParams {
  registryDir: string;
  env: NodeJS.ProcessEnv;
  /** Injectable so ticket expiry can be tested without waiting for it. */
  now?: () => number;
}

/**
 * How long a per-call ticket is believed.
 *
 * opencode reaches `tool.execute.after` only by falling off the end of a
 * successful call — an error, a denied permission or an abort skip it
 * [verified against 1.18.32] — so tickets leak routinely and something has to
 * forget them.
 *
 * Sixty seconds sits far from both failure modes. Too short and a slow call
 * outlives its own ticket, leaving us unable to identify the very session we
 * are serving; a send has a 500ms deadline on the socket write, so this is
 * ~100x headroom and a live call should never age out. Too long and one
 * crashed call keeps a window from seeing its own siblings; a minute is
 * recoverable, five would not be.
 */
export const CALL_TICKET_TTL_MS = 60_000;

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
/**
 * A well-formed opencode session id.
 *
 * SPEC §7 already makes a `^ses` prefix a hard requirement on the wire, so
 * this rejects nothing legitimate. It exists because a session id read out of
 * a registry or caller file is *file content*, and both readers turn it into a
 * path: `../../../victim` would otherwise name `<registryDir>/../../../victim.json`.
 * Shared by `discover.ts` and `selfSessionId` below for the same reason
 * `parseOpencodePid` is shared — one guard, tightened in one place.
 */
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;

export function isOpencodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function parseOpencodePid(env: NodeJS.ProcessEnv): number | undefined {
  const pid = Number(env.OPENCODE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * `at` as epoch milliseconds, or `undefined` when it is missing or unusable.
 *
 * Deliberately not `Date.parse` alone: that returns NaN for junk, and NaN
 * silently loses every comparison it takes part in — including the one that
 * would otherwise rank a well-dated record above an undated one.
 */
function callerStamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
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
 *
 * RESOLUTION ORDER. Fresh per-call tickets first: a ticket means a Tin Can
 * call is in flight on this process, and ours is one by definition, so if
 * every fresh ticket names the same session then that session is us — decided,
 * not guessed. Two sessions with calls in flight is real ambiguity and answers
 * `undefined` rather than falling through to a confident wrong answer. Only
 * with no fresh ticket at all do we fall back to the caller file below, which
 * is what an older plugin writes and what a call slower than
 * `CALL_TICKET_TTL_MS` degrades to.
 *
 * SEVERAL caller files can match one pid, so among them the newest wins rather
 * than the first. opencode instantiates a plugin more than once per process — four
 * bound instance sockets under a single pid on opencode 1.18.31, issue #19 —
 * and each instance writes its own `inst-<id>.caller.json` stamped with the
 * same `process.pid`, naming whichever session last called a Tin Can tool on
 * *that* instance. Taking the first readdir match therefore pins "self" to an
 * arbitrary sibling: the current session is then not excluded from its own
 * peer list and a self-send delivers, which is the exact failure runtime.ts's
 * "deliberately NOT cached across calls" note exists to prevent. That note
 * assumed one caller file per process; the stale files on disk reintroduce it.
 *
 * `at` is only whole seconds (SPEC §4), so two sessions calling inside the
 * same second tie — broken by the file's own mtime, which `writeJsonAtomic`
 * sets on the temp file and `rename` carries over unchanged.
 */
export async function selfSessionId(params: SelfSessionParams): Promise<string | undefined> {
  const { registryDir, env, now = () => Date.now() } = params;

  const selfPid = parseOpencodePid(env);
  if (selfPid === undefined) return undefined;

  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch {
    return undefined; // Registry directory absent: plugin not installed, or not yet.
  }

  // A fresh ticket means a Tin Can tool call is in flight on this process.
  // Ours is, by definition — we are inside one. So if every fresh ticket
  // names the same session, that session is us, with no appeal to recency.
  const live = new Set<string>();
  const cutoff = now() - CALL_TICKET_TTL_MS;

  for (const name of names) {
    if (!name.startsWith('inst-') || !name.endsWith('.call.json')) continue;
    const rec = await readRecord(join(registryDir, name));
    if (rec === undefined) continue;
    if (rec.pid !== selfPid || !isOpencodeSessionId(rec.session_id)) continue;
    // Unaged is untrusted. A ticket whose `at` cannot be read can never be
    // expired, so believing it would let one bad record block self-resolution
    // for the life of the process.
    const at = callerStamp(rec.at);
    if (at === undefined || at < cutoff) continue;
    live.add(rec.session_id);
  }

  if (live.size === 1) return [...live][0];
  // Two sessions genuinely have calls in flight and nothing on disk says which
  // is ours. `undefined` means "exclude the whole instance" to the caller:
  // over-excluding a sibling is inconvenient, under-excluding risks a
  // self-send. Deliberately does NOT fall through to the caller file, which
  // would answer confidently and might answer wrongly.
  if (live.size > 1) return undefined;

  // No fresh ticket: either the plugin predates them — it installs separately
  // from this core, so that skew is normal — or ours expired under a call
  // slower than the TTL. Both degrade to the previous behaviour.
  return newestCaller(registryDir, names, selfPid);
}

/**
 * The pre-ticket resolution, kept as the fallback: newest caller file wins,
 * `at` first and then mtime, because `at` is whole seconds (SPEC §4) and two
 * sessions can call inside one second.
 *
 * This is what an older plugin's files still resolve through, and what a
 * current plugin falls back to when a call outlives its ticket. It remains
 * wrong in exactly the case tickets exist to fix — a sibling overwriting the
 * shared file mid-read — which is why it is reached only when there is no
 * ticket to prefer.
 */
async function newestCaller(
  registryDir: string,
  names: string[],
  selfPid: number,
): Promise<string | undefined> {
  let best: { sessionId: string; at: number; mtimeMs: number } | undefined;

  for (const name of names) {
    if (!name.startsWith('inst-') || !name.endsWith('.caller.json')) continue;
    const path = join(registryDir, name);
    const rec = await readRecord(path);
    if (rec === undefined) continue;

    // The id is turned into a registry path by runtime.ts's slug lookup, so
    // it is validated here rather than trusted as written. An invalid id is
    // dropped from the running rather than allowed to win and then be
    // rejected, so an older well-formed record still identifies us.
    if (rec.pid !== selfPid || !isOpencodeSessionId(rec.session_id)) continue;

    // `-1` sorts an undated or unparseably-dated record below every dated
    // one while still beating nothing at all, so a plugin that stopped
    // writing `at` degrades to "some sibling" rather than to "no self".
    const at = callerStamp(rec.at) ?? -1;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      // Vanished under us between read and stat. The record is still usable;
      // it just cannot win a tie.
    }

    if (best === undefined || at > best.at || (at === best.at && mtimeMs > best.mtimeMs)) {
      best = { sessionId: rec.session_id, at, mtimeMs };
    }
  }

  return best?.sessionId;
}

/**
 * One JSON record, or `undefined` for anything we cannot use.
 *
 * The plugin can unlink or rewrite these between our readdir and our read
 * (dispose, the orphan sweep, a concurrent tool call), so a vanished file is
 * normal rather than an error.
 */
async function readRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
