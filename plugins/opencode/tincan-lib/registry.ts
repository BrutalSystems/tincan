import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionFile, socketPath } from './paths.js';
import type { RegistryRecord, SessionInfo, SessionState } from './types.js';

export interface RecordContext {
  socket: string;
  instance_id: string;
  pid: number;
  plugin_version: string;
  now: () => Date;
}

/** ISO 8601 to whole seconds, as SPEC §4's example shows. */
export function isoStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

export function composeRecord(info: SessionInfo, state: SessionState, ctx: RecordContext): RegistryRecord {
  return {
    session_id: info.id,
    slug: info.slug,
    title: info.title,
    directory: info.directory,
    state,
    socket: ctx.socket,
    instance_id: ctx.instance_id,
    pid: ctx.pid,
    plugin_version: ctx.plugin_version,
    opencode_version: info.version,
    updated_at: isoStamp(ctx.now()),
  };
}

export function sameIgnoringTimestamp(a: RegistryRecord, b: RegistryRecord): boolean {
  const { updated_at: _a, ...restA } = a;
  const { updated_at: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** Atomic: temp file in the same directory, then rename. SPEC §4. */
export async function writeRecord(dir: string, rec: RegistryRecord): Promise<void> {
  // mkdir's `mode` is ignored when the directory already exists — and Tin Can
  // itself may have created ~/.tincan/peers at 0755. chmod unconditionally, or
  // the 0700 parent that closes the bind-to-chmod race in SPEC §8.3 is a
  // fiction.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const final = sessionFile(dir, rec.session_id);
  const tmp = `${final}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, final);
}

export async function removeRecord(dir: string, sessionID: string): Promise<void> {
  try {
    await unlink(sessionFile(dir, sessionID));
  } catch {
    // Already gone is the desired end state.
  }
}

export async function removeAllForInstance(dir: string, instanceID: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as RegistryRecord;
      if (rec.instance_id === instanceID) await unlink(join(dir, name));
    } catch {
      // Unreadable or unparseable: not ours to delete.
    }
  }
}

/**
 * Delete the socket and registry files of every instance whose socket refuses
 * a connection. The instance id is fresh on every load, so without this a
 * `kill -9` leaves files nobody will ever reclaim. SPEC §6.
 *
 * Sockets are enumerated directly rather than read off records: because the
 * plugin advertises nothing at load (SPEC §5), a crashed instance that never
 * saw a session event leaves a socket with no record pointing at it, and that
 * is the common case, not an edge case.
 */
export async function sweepOrphans(
  dir: string,
  selfInstance: string,
  probe: (socketPath: string) => Promise<boolean>,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const instances = new Map<string, { files: string[]; socket: string }>();
  const entryFor = (id: string) => {
    let entry = instances.get(id);
    if (!entry) {
      entry = { files: [], socket: socketPath(dir, id) };
      instances.set(id, entry);
    }
    return entry;
  };

  for (const name of names) {
    if (name.endsWith('.sock')) {
      const id = name.slice(0, -'.sock'.length);
      if (id !== selfInstance) entryFor(id);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as RegistryRecord;
      if (typeof rec.instance_id !== 'string' || rec.instance_id === selfInstance) continue;
      entryFor(rec.instance_id).files.push(join(dir, name));
    } catch {
      // Unreadable or unparseable: not ours to delete.
    }
  }

  const swept: string[] = [];
  for (const [instance, entry] of instances) {
    let alive = false;
    try {
      alive = await probe(entry.socket);
    } catch {
      alive = false;
    }
    if (alive) continue;
    for (const file of entry.files) {
      try { await unlink(file); } catch { /* already gone */ }
    }
    try { await unlink(entry.socket); } catch { /* already gone */ }
    swept.push(instance);
  }
  return swept;
}
