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
