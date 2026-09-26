/**
 * opencode peer discovery.
 *
 * The plugin inside opencode writes one record per live session; Tin Can only
 * reads them. A default opencode TUI opens no TCP port, so there is nothing to
 * query — the registry and the instance socket are the entire interface.
 * See plugins/opencode/SPEC.md §4.
 */
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import net from 'node:net';
import type { PeerState } from '../claude/discover.js';
import { isOpencodeSessionId } from './self.js';

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
  /**
   * Records already reported unreachable by an earlier listing, keyed by
   * absolute record path. A record is pruned only on the *second* consecutive
   * refusal (see `listOpencodeSessions`), so the mark has to outlive one call.
   *
   * Defaults to a process-wide set, which is what a long-lived MCP server
   * wants; tests may pass their own for isolation.
   */
  unreachableMarks?: Set<string>;
}

/**
 * Records this process has already reported unreachable once. Not a cache of
 * anything — it is the first of the two observations the prune requires.
 */
const reportedUnreachable = new Set<string>();

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

/**
 * A record plus the directory entry it came from.
 *
 * `file` is the only thing the prune is ever allowed to unlink. A path built
 * from the record's *contents* is attacker-controlled — a `session_id` of
 * `../../../victim` deleted `<registryDir>/../../../victim.json` — and it is
 * also simply wrong the moment the plugin names a file anything other than
 * `<session_id>.json`, because the unlink then silently misses and "report
 * unreachable once" becomes "report it forever".
 */
interface RegistryEntry {
  file: string;
  session: OpencodeSession;
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
  // `session_id` is held to SPEC §7's `^ses` requirement, not merely to being
  // a non-empty string: it is content that later becomes a path (runtime.ts's
  // slug lookup) and an address on the wire. A record that fails it is skipped
  // exactly like a malformed one.
  if (!isOpencodeSessionId(r.session_id) || !str(r.directory) || !str(r.socket)) return null;
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

/**
 * Forget marks for records this listing did not see.
 *
 * Marks for records that have since vanished (the plugin's own sweep, a
 * `session.deleted`) would otherwise accumulate for the life of the process.
 * Scoped by prefix: the default set is process-wide and a second registry
 * directory's marks are none of this call's business.
 *
 * Called on the ENOENT path too, with an empty `seen` — the whole directory
 * vanishing is the same fact about every record in it, only more so. That
 * path used to return before this ran (#6), and the leak was not merely
 * untidy: a mark means "already reported unreachable once", so a directory
 * that came back with the same record and a still-refused socket had its peer
 * pruned in silence instead of being reported unreachable the one time it is
 * owed.
 *
 * NOT called for other readdir failures. EACCES or EIO leaves the records in
 * place and unread, so their marks are still true; dropping them there would
 * re-report every peer as unreachable on the next successful listing.
 */
function forgetVanishedMarks(marks: Set<string>, registryDir: string, seen: Set<string>): void {
  const prefix = registryDir.endsWith(sep) ? registryDir : registryDir + sep;
  for (const key of marks) {
    if (key.startsWith(prefix) && !seen.has(key)) marks.delete(key);
  }
}

export async function listOpencodeSessions(params: ListParams): Promise<OpencodeListing> {
  const {
    registryDir,
    probe = probeSocket,
    probeMs = 250,
    unreachableMarks: marks = reportedUnreachable,
  } = params;
  let names: string[];
  try {
    names = await readdir(registryDir);
  } catch (e) {
    // Distinguish "plugin not installed" from a real failure. Change notice §1
    // is explicit that an empty list must name the plugin rather than look
    // like a working system with no peers.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') forgetVanishedMarks(marks, registryDir, new Set());
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

  const found: RegistryEntry[] = [];
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
    if (rec !== null) found.push({ file: name, session: rec });
  }

  // One probe per instance, not per session: an instance serves many sessions
  // behind one socket. Probed in parallel so N dead instances cost one timeout,
  // not N.
  const sockets = [...new Set(found.map((e) => e.session.socketPath))];
  const results = await Promise.all(
    sockets.map(async (sock) => {
      try { return [sock, await probe(sock, probeMs)] as const; }
      catch { return [sock, false] as const; }
    }),
  );
  const alive = new Map(results);

  // A refused socket means the instance is *probably* gone. Report the peer
  // once as unreachable rather than dropping it — that is what makes tools.ts's
  // `peer_unreachable` refusal reachable, and it mirrors claude/discover.ts:74.
  //
  // Removal takes a second, confirming refusal. One refused 250ms probe is not
  // proof: the plugin only rewrites a record on an event (SPEC §5), so a
  // wrongly pruned instance that is idle and stays idle does not "self-heal on
  // the next state write" — it is invisible in every peer list until someone
  // types into it. The mark is held in memory rather than written into the
  // record, so nothing here ever writes to a file the plugin owns.
  //
  // User-visible behaviour is unchanged: the peer is reported unreachable
  // exactly once (on the first refusal), and never appears again.
  const peers: OpencodeSession[] = [];
  const prune: string[] = [];
  const seen = new Set<string>();
  for (const entry of found) {
    const key = join(registryDir, entry.file);
    seen.add(key);
    if (alive.get(entry.session.socketPath) === true) {
      marks.delete(key); // a slow instance that answered is not dying
      peers.push(entry.session);
      continue;
    }
    if (marks.has(key)) {
      marks.delete(key);
      prune.push(entry.file);
      continue;
    }
    marks.add(key);
    peers.push({ ...entry.session, state: 'unreachable' });
  }

  forgetVanishedMarks(marks, registryDir, seen);

  await Promise.all(prune.map((file) => unlink(join(registryDir, file)).catch(() => {})));
  return { peers };
}
