/**
 * opencode peer discovery.
 *
 * The plugin inside opencode writes one record per live session; Tin Can only
 * reads them. A default opencode TUI opens no TCP port, so there is nothing to
 * query — the registry and the instance socket are the entire interface.
 * See plugins/opencode/SPEC.md §4.
 */
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import type { PeerState } from '../claude/discover.js';

export interface OpencodeSession {
  uuid: string;          // session_id
  rawName: string | null; // slug — never the title, which drifts. null when absent.
  cwd: string;
  state: PeerState;
  socketPath: string;
  instanceId: string;
  pid: number;
}

/** Mirrors CodexListing: a diagnostic is how `peers` explains an empty list. */
export interface OpencodeListing {
  peers: OpencodeSession[];
  diagnostic?: string;
}

export interface ListParams {
  registryDir: string;
  /** Injected so tests need no real sockets. Defaults to a real connect probe. */
  probe?: (socketPath: string, timeoutMs: number) => Promise<boolean>;
  probeMs?: number;
}

/** The liveness test the whole staleness model rests on: a dead instance's
 *  socket refuses the connection. SPEC §6. */
export function probeSocket(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch { /* already gone */ }
      resolve(alive);
    };
    const c = net.connect(socketPath);
    c.setTimeout(timeoutMs, () => finish(false));
    c.on('connect', () => finish(true));
    c.on('error', () => finish(false));
  });
}

function readRecord(raw: string): OpencodeSession | null {
  let r: Record<string, unknown>;
  try { r = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  // Addressability is the bar, not completeness. A record without an id, a
  // directory or a socket cannot be reached, so it is not a peer. A record
  // without a slug is merely unnamed — naming.ts already handles that
  // (rawName: null becomes 'thread' and is always suffixed), exactly as
  // claude/discover.ts does. SPEC §12 notes slug is undeclared in opencode's
  // schema, so a build without it is plausible; dropping a live, reachable
  // session over a missing name would make it invisible with no diagnostic.
  if (!str(r.session_id) || !str(r.directory) || !str(r.socket)) return null;
  if (!str(r.instance_id) || typeof r.pid !== 'number') return null;
  return {
    uuid: r.session_id,
    rawName: str(r.slug) ? r.slug : null,
    // `title` is deliberately dropped. The change notice permits carrying it
    // as a description; we do not, because it drifts and nothing consumes it.
    cwd: r.directory,
    state: r.state === 'busy' ? 'busy' : 'idle',
    socketPath: r.socket,
    instanceId: r.instance_id,
    pid: r.pid,
  };
}

export async function listOpencodeSessions(params: ListParams): Promise<OpencodeListing> {
  const { registryDir, probe = probeSocket, probeMs = 250 } = params;
  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch (e) {
    // Distinguish "plugin not installed" from a real failure. Change notice §1
    // is explicit that an empty list must name the plugin rather than look
    // like a working system with no peers.
    const code = (e as NodeJS.ErrnoException).code;
    return {
      peers: [],
      diagnostic:
        code === 'ENOENT'
          ? 'No opencode peers: the Tin Can opencode plugin does not appear to be ' +
            'installed. It is what makes opencode sessions addressable — see ' +
            'plugins/opencode/README.md. Without it there are no opencode peers, ' +
            'which is expected, not a fault.'
          : `Could not read the opencode registry at ${registryDir}: ${String(e)}`,
    };
  }

  const found: OpencodeSession[] = [];
  for (const name of names) {
    // Session records only. inst-*.caller.json, inst-*.sock and the atomic
    // writer's *.tmp files live in the same directory.
    if (!name.startsWith('ses_') || !name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = await readFile(join(registryDir, name), 'utf8');
    } catch {
      continue; // The plugin deletes concurrently; a vanished file is normal.
    }
    const rec = readRecord(raw);
    if (rec !== null) found.push(rec);
  }

  // One probe per instance, not per session: an instance serves many sessions
  // behind one socket. Probed in parallel so N dead instances cost one timeout,
  // not N.
  const sockets = [...new Set(found.map((s) => s.socketPath))];
  const results = await Promise.all(
    sockets.map(async (sock) => {
      try { return [sock, await probe(sock, probeMs)] as const; }
      catch { return [sock, false] as const; }
    }),
  );
  const alive = new Map(results);

  // A refused socket means the instance is gone. Report the peer once as
  // unreachable rather than dropping it — that is what makes tools.ts's
  // `peer_unreachable` refusal reachable, and it mirrors claude/discover.ts:74.
  // Then unlink the record so the next listing does not repeat it (change
  // notice §2: "report the peer unreachable once rather than repeatedly").
  const peers = found.map((s) =>
    alive.get(s.socketPath) === true ? s : { ...s, state: 'unreachable' as const },
  );
  await Promise.all(
    peers
      .filter((s) => s.state === 'unreachable')
      .map((s) => unlink(join(registryDir, `${s.uuid}.json`)).catch(() => {})),
  );
  return { peers };
}
