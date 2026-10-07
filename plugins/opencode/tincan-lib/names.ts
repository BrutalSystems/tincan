import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './registry.js';

/**
 * Session names (slugs), remembered across background-service restarts.
 * opencode 2.x only. SPEC §5.1.
 *
 * Every Tin Can address is built from a session's slug, and 2.x puts the slug
 * on `session.created` and nowhere else — not on SessionInfo, not on any later
 * event, and the plugin context has no way to read the event log that holds it
 * [verified 2.0.24]. So a session created before the service last started
 * could never be advertised again. The plugin keeps its own copy.
 *
 * One file per session, under `names/` beside the registry: the core reads
 * only `ses_*.json` at the top level, so it never mistakes one for a peer; and
 * several plugin instances (one per directory, in one service) never write the
 * same file, so there is no read-modify-write to lose an update in.
 */

/** The id becomes a file name, so it is held to exactly what opencode mints. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;

/** Long enough to cover a holiday; short enough that deleted-while-away
 *  sessions, which never send `session.deleted` to us, do not pile up. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface NameRecord {
  session_id: string;
  slug: string;
  /** Epoch ms of the last time this session was seen. */
  at: number;
}

const namesDir = (dir: string) => join(dir, 'names');
const nameFile = (dir: string, id: string) => join(namesDir(dir), `${id}.json`);

export async function rememberName(dir: string, sessionID: string, slug: string, now: number): Promise<void> {
  if (!SESSION_ID.test(sessionID) || slug === '') return;
  const rec: NameRecord = { session_id: sessionID, slug, at: now };
  await writeJsonAtomic(nameFile(dir, sessionID), rec);
}

export async function recallName(dir: string, sessionID: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionID)) return undefined;
  try {
    const rec = JSON.parse(await readFile(nameFile(dir, sessionID), 'utf8')) as Partial<NameRecord>;
    return rec.session_id === sessionID && typeof rec.slug === 'string' && rec.slug !== '' ? rec.slug : undefined;
  } catch {
    return undefined;
  }
}

export async function forgetName(dir: string, sessionID: string): Promise<void> {
  if (!SESSION_ID.test(sessionID)) return;
  try { await unlink(nameFile(dir, sessionID)); } catch { /* already gone */ }
}

export async function pruneNames(dir: string, now: number): Promise<void> {
  let files: string[];
  try { files = await readdir(namesDir(dir)); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const path = join(namesDir(dir), f);
    try {
      const rec = JSON.parse(await readFile(path, 'utf8')) as Partial<NameRecord>;
      if (typeof rec.at === 'number' && now - rec.at <= MAX_AGE_MS) continue;
    } catch { /* unreadable: prune it */ }
    try { await unlink(path); } catch { /* raced another instance */ }
  }
}
