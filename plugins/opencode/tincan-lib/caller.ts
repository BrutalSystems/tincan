import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isoStamp, writeJsonAtomic, type RecordContext } from './registry.js';

/**
 * Which session is currently talking to Tin Can's MCP server.
 *
 * opencode exports no OPENCODE_SESSION_ID into tool subprocesses, and pid
 * ancestry only identifies the instance. The `tool.execute.before` hook does
 * carry the calling sessionID, so the plugin records it here for Tin Can to
 * read when it needs to exclude itself from its own peer list.
 */
export interface CallerRecord {
  instance_id: string;
  session_id: string;
  pid: number;
  tool: string;
  at: string;
}

/** Distinct from a session record, which is always `ses_*.json`. */
export function callerFile(dir: string, instanceID: string): string {
  return join(dir, `${instanceID}.caller.json`);
}

/**
 * opencode names an MCP tool `<server key>_<tool name>`, and the server key is
 * whatever the user put in their opencode config — `tincan`, `tc`, anything.
 * So match the tool-name suffix, never a prefix. A leading `_` is required, so
 * a built-in called `peers` does not match.
 */
const TINCAN_TOOLS = ['peers', 'send_peer', 'message_log'];

export function isTincanTool(toolID: string): boolean {
  return TINCAN_TOOLS.some((name) => toolID.endsWith(`_${name}`));
}

export function composeCaller(sessionID: string, toolID: string, ctx: RecordContext): CallerRecord {
  return {
    instance_id: ctx.instance_id,
    session_id: sessionID,
    pid: ctx.pid,
    tool: toolID,
    at: isoStamp(ctx.now()),
  };
}

export async function writeCaller(dir: string, rec: CallerRecord): Promise<void> {
  await writeJsonAtomic(callerFile(dir, rec.instance_id), rec);
}

/**
 * A per-call ticket, written when a Tin Can tool starts and removed when it
 * ends. Tin Can reads these to identify the calling session *certainly*
 * rather than by recency: its own call is in flight by definition, so exactly
 * one fresh ticket for our pid can only be ours (#3).
 *
 * Kept ALONGSIDE the single caller file above, not instead of it. The plugin
 * installs separately from the core, so an older core that only knows
 * `inst-<id>.caller.json` must keep working exactly as it does today. The
 * distinct `.call.json` suffix also keeps these invisible to that core's
 * `.caller.json` glob.
 *
 * They still carry `instance_id`, so `dispose` and the orphan sweep reclaim
 * them by the same path as every other file here.
 */
export interface CallTicket extends CallerRecord {
  call_id: string;
}

/**
 * opencode's callID is an opaque host string and this makes it a path
 * segment, so it is constrained rather than trusted: anything outside
 * `[A-Za-z0-9_-]` becomes `-`, and the result is capped. A `.` would collide
 * with the suffix scheme and `/` or `..` would escape the directory.
 */
export function sanitizeCallId(callID: string): string {
  const safe = callID.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return safe.length > 0 ? safe : 'anon';
}

/** Distinct from `<instance>.caller.json`, which an older core still reads. */
export function callTicketFile(dir: string, instanceID: string, callID: string): string {
  return join(dir, `${instanceID}.${sanitizeCallId(callID)}.call.json`);
}

export function composeCallTicket(
  sessionID: string,
  toolID: string,
  callID: string,
  ctx: RecordContext,
): CallTicket {
  return { ...composeCaller(sessionID, toolID, ctx), call_id: sanitizeCallId(callID) };
}

export async function writeCallTicket(dir: string, rec: CallTicket): Promise<void> {
  await writeJsonAtomic(callTicketFile(dir, rec.instance_id, rec.call_id), rec);
}

/**
 * opencode fires `tool.execute.after` only when the call succeeded — an error,
 * a denied permission or an abort skip it entirely [verified, 1.18.32], so
 * tickets leak by design and the reader expires them. This is the tidy path,
 * not the guarantee.
 */
export async function removeCallTicket(
  dir: string,
  instanceID: string,
  callID: string,
): Promise<void> {
  try {
    await unlink(callTicketFile(dir, instanceID, callID));
  } catch {
    // Already gone: a sweep, a dispose, or never written.
  }
}
