/** Append-only JSONL message log (§9). Written before delivery is attempted. */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Envelope } from './envelope.js';

export interface MessageRecord {
  id: string;
  at: string;
  direction: 'out';
  from: Envelope['from'];
  to: Envelope['to'];
  text: string;
  method: Envelope['method'];
  delivered: boolean;
  expect_reply: boolean;
  in_reply_to?: string;
  /** Set by a replier: this message answers the question, rather than acknowledging it. */
  answers?: boolean;
  /** Shared by every delivery of one fan-out. */
  broadcast_id?: string;
  /**
   * Computed at read time, never written.
   *
   * A send is logged BEFORE it is attempted, so a crash in between leaves a
   * message record with no outcome record beside it. That used to read
   * identically to a delivery that failed — reporting a guess as a fact.
   * `indeterminate` says what is actually known: it was written out, and
   * nothing ever observed what became of it.
   */
  outcome?: 'accepted' | 'failed' | 'indeterminate';
  /**
   * Computed at read time for messages with `expect_reply`, never written.
   * Absent on every other message: a record that never asked for an answer
   * should not report one way or the other.
   */
  answered?: boolean;
  /**
   * The effective delivery mode requested for this send: `'steer'` only when
   * `urgent` was set AND the peer's runtime can act on it (opencode today);
   * `'queue'` otherwise, including every urgent send to a runtime that has no
   * interrupt (Codex, Claude Code). This is what actually happened to the
   * peer's turn, not bare `urgent` intent — the two differ for exactly the
   * runtimes that cannot steer. Optional so records written before this field
   * existed still parse; absence does not imply `'queue'`.
   */
  delivery?: 'queue' | 'steer';
  /** Set by folding a later outcome record; never written directly. */
  notice?: string;
  kind?: undefined;
}

export interface NoticeRecord {
  id: string;
  at: string;
  kind: 'notice';
  detail: string;
}

export interface DroppedRecord {
  id: string;
  at: string;
  kind: 'dropped';
  reason: string;
}

/**
 * The head of a rotated live file: the records before it were moved to the
 * archive named by `into`.
 *
 * It is an ordinary chained record — its `prev` names the last record that was
 * moved out — so archive and live file remain one verifiable chain, and a
 * rotation is visible rather than history simply being shorter than it was.
 *
 * `allWithIntegrity` treats it as a resync point. That is not optional: the
 * record after it chains from the last ARCHIVED record, so judging that link
 * against the checkpoint's own hash would report a break on every rotated log.
 * Pinned by a test.
 */
export interface CheckpointRecord {
  id: string;
  at: string;
  kind: 'checkpoint';
  /** How many records were moved out. */
  rotated: number;
  /** Basename of the archive they were moved into. */
  into: string;
}

/**
 * The outcome of a send, appended after the attempt. The log is append-only, so
 * a delivery result cannot rewrite its message record — `read` folds these onto
 * the message instead, leaving one logical record per message (§9).
 */
export interface OutcomeRecord {
  id: string;
  at: string;
  kind: 'outcome';
  delivered: boolean;
  detail?: string;
}

/**
 * Chain metadata carried by every record written since #17 phase 1.
 *
 * What this buys: a truncated write, a corrupted file or a careless edit stops
 * being a log that quietly reports fewer messages than happened, and becomes
 * one that says so. What it does NOT buy: protection from a deliberate
 * same-user adversary. The chain lives in the same file as the data, so
 * anything that can rewrite the log can recompute it — and that adversary can
 * already replace the `tincan` binary, so there is nothing here to defend.
 *
 * `key_id` and `sig` are phase 2's slots and are never written today. They are
 * declared now, and deliberately excluded from the hash, so that signing a
 * record later does not change its hash and force a rewrite of every record
 * after it. That migration is the whole cost this empty slot avoids.
 */
export interface ChainFields {
  /** Hash of the previous record, or `GENESIS` for the first of a chain. */
  prev?: string;
  /** sha256 over this record with `hash` and `sig` removed. */
  hash?: string;
  key_id?: string;
  sig?: string;
}

export type LogRecord = (
  | MessageRecord
  | NoticeRecord
  | DroppedRecord
  | OutcomeRecord
  | CheckpointRecord
) &
  ChainFields;

/** `prev` of the first record in a chain. */
export const GENESIS = 'genesis';

export interface LogIntegrity {
  ok: boolean;
  /** Lines that were not JSON at all — a truncated or half-written write. */
  unparseable: number;
  /** Records whose contents no longer hash to the value they carry. */
  tampered: number;
  /** Records whose `prev` does not name the record before them. */
  broken: number;
  /** Records predating chaining. Expected on an upgraded install, not a fault. */
  unchained: number;
  /**
   * Set when older history was deliberately rotated out. Not a fault — but a
   * caller seeing fewer records than it expected deserves to know why, rather
   * than concluding the log lost them.
   */
  rotated?: { count: number; into: string; at: string };
  /** Said plainly, because a model reads this and has to decide what to do. */
  detail?: string;
}

/**
 * JSON with object keys sorted, recursively.
 *
 * The hash has to survive a round trip through `JSON.parse`, and key order is
 * an artefact of how a record was built rather than part of its meaning. Sorting
 * makes the hash depend on the content alone, so adding a field to a record
 * type later cannot silently invalidate history.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** Excludes `hash` (it is the output) and `sig` (see ChainFields). */
export function recordHash(rec: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'hash' || k === 'sig') continue;
    rest[k] = v;
  }
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

export interface ReadQuery {
  peer?: string;
  thread?: string;
  last_n: number;
}

export function messagesPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(env.TINCAN_HOME ?? join(home, '.tincan'), 'messages.jsonl');
}

/** Defaults chosen to bound the read cost without discarding useful history. */
export const ROTATE_MAX_BYTES = 5 * 1024 * 1024;

export interface LogOptions {
  /** Rotate once the live file exceeds this. 0 disables rotation entirely. */
  maxBytes?: number;
}

export class MessageLog {
  private readonly maxBytes: number;

  constructor(
    private readonly path: string,
    opts: LogOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? ROTATE_MAX_BYTES;
  }

  /** Where rotated records go: messages.jsonl -> messages.archive.jsonl. */
  private get archivePath(): string {
    return `${this.path.replace(/\.jsonl$/, '')}.archive.jsonl`;
  }

  appendMessage(e: Envelope, delivered: boolean, delivery?: 'queue' | 'steer'): MessageRecord {
    const rec: MessageRecord = {
      id: e.id,
      at: e.at,
      direction: 'out',
      from: e.from,
      to: e.to,
      text: e.text,
      method: e.method,
      delivered,
      expect_reply: e.expect_reply,
      ...(e.in_reply_to !== undefined && { in_reply_to: e.in_reply_to }),
      ...(e.answers === true && { answers: true }),
      ...(e.broadcast_id !== undefined && { broadcast_id: e.broadcast_id }),
      ...(delivery !== undefined && { delivery }),
    };
    this.append(rec);
    return rec;
  }

  appendOutcome(id: string, delivered: boolean, detail?: string): OutcomeRecord {
    const rec: OutcomeRecord = {
      id,
      at: new Date().toISOString(),
      kind: 'outcome',
      delivered,
      ...(detail !== undefined && { detail }),
    };
    this.append(rec);
    return rec;
  }

  appendNotice(id: string, detail: string): NoticeRecord {
    const rec: NoticeRecord = { id, at: new Date().toISOString(), kind: 'notice', detail };
    this.append(rec);
    return rec;
  }

  appendDropped(id: string, reason: string): DroppedRecord {
    const rec: DroppedRecord = { id, at: new Date().toISOString(), kind: 'dropped', reason };
    this.append(rec);
    return rec;
  }

  /**
   * The message record with this id, if the live log still holds one.
   *
   * Used to check that a reply is going to whoever actually sent the message
   * it answers. Returns undefined for an id that has rotated out or was never
   * here — the caller must treat that as "cannot check", never as "wrong",
   * or an upgrade would break every conversation already in flight.
   */
  findMessage(id: string): MessageRecord | undefined {
    for (const rec of this.allWithIntegrity().records) {
      if (rec.id === id && isMessage(rec)) return rec;
    }
    return undefined;
  }

  /** Convenience for the callers that do not inspect integrity. */
  read(query: ReadQuery): LogRecord[] {
    return this.readWithIntegrity(query).records;
  }

  readWithIntegrity(query: ReadQuery): { records: LogRecord[]; integrity: LogIntegrity } {
    const { records: raw, integrity } = this.allWithIntegrity();
    let records = this.fold(raw);

    if (query.thread !== undefined) {
      const chain = new Set<string>([query.thread]);
      // One forward pass: records are appended in causal order, so a reply
      // always follows the message it answers.
      for (const r of records) {
        const parent = isMessage(r) ? r.in_reply_to : undefined;
        if (parent !== undefined && chain.has(parent)) chain.add(r.id);
      }
      records = records.filter((r) => chain.has(r.id));
    }

    if (query.peer !== undefined) {
      const peer = query.peer.toLowerCase();
      records = records.filter(
        (r) => isMessage(r) && (r.to.name.toLowerCase() === peer || r.from.name.toLowerCase() === peer),
      );
    }

    return { records: records.slice(-query.last_n), integrity };
  }

  /** Applies outcome records to their message and drops them from the result. */
  private fold(records: LogRecord[]): LogRecord[] {
    const outcomes = new Map<string, OutcomeRecord>();
    for (const r of records) if (r.kind === 'outcome') outcomes.set(r.id, r);

    // Only a reply that CLAIMS to answer discharges the question. Collecting
    // every record with a matching `in_reply_to` would let "got it" close a
    // question nobody answered — and a log that reports an unanswered question
    // as answered is worse than one that reports nothing at all.
    const answered = new Set<string>();
    for (const r of records) {
      if (isMessage(r) && r.answers === true && r.in_reply_to !== undefined) {
        answered.add(r.in_reply_to);
      }
    }

    return records
      .filter((r) => r.kind !== 'outcome' && r.kind !== 'checkpoint')
      .map((r) => {
        const o = isMessage(r) ? outcomes.get(r.id) : undefined;
        let folded: LogRecord;
        if (!isMessage(r)) {
          folded = r;
        } else {
          // `delivered` is still WRITTEN — the persisted format is history and
          // is not worth migrating — but it is not returned. It was always
          // false at write time and only became meaningful once an outcome
          // record was folded onto it, which is precisely the confusion
          // `outcome` exists to end.
          const { delivered: legacy, ...rest } = r;
          const outcome =
            o !== undefined
              ? o.delivered
                ? ('accepted' as const)
                : ('failed' as const)
              : // No outcome record. On a current log that means the process
                // died between writing and delivering. A very old record that
                // carries a true `delivered` and no outcome is taken at its
                // word rather than reported as unknown.
                legacy === true
                ? ('accepted' as const)
                : ('indeterminate' as const);
          folded = {
            ...rest,
            outcome,
            ...(o?.detail !== undefined && { notice: o.detail }),
          } as LogRecord;
        }
        if (!isMessage(r) || !r.expect_reply) return folded;
        return { ...folded, answered: answered.has(r.id) };
      });
  }

  private allWithIntegrity(): { records: LogRecord[]; integrity: LogIntegrity } {
    const tally = { unparseable: 0, tampered: 0, broken: 0, unchained: 0 };
    let rotated: LogIntegrity['rotated'];
    if (!existsSync(this.path)) return { records: [], integrity: summarise(tally) };

    const out: LogRecord[] = [];
    let expected: string | undefined; // hash the next record should name in `prev`
    // After damage we cannot know what the next record's `prev` ought to be,
    // so the following link is not judged. One fault counted once: blaming
    // the innocent record after a truncated line for a second break would
    // double every real problem.
    let resync = false;

    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        // Still skipped — a truncated line must not cost us the rest of the
        // log — but no longer in silence, which was the defect.
        tally.unparseable++;
        resync = true;
        continue;
      }
      out.push(rec);

      if (typeof rec.hash !== 'string') {
        // Predates chaining. Expected on any install with history.
        tally.unchained++;
        expected = undefined;
        resync = true;
        continue;
      }
      if (recordHash(rec as unknown as Record<string, unknown>) !== rec.hash) {
        tally.tampered++;
      } else if (!resync && expected !== undefined && rec.prev !== expected) {
        tally.broken++;
      }
      if (rec.kind === 'checkpoint') {
        rotated = { count: rec.rotated, into: rec.into, at: rec.at };
        // The record after this one chains from the archive, not from anything
        // in this file, so its link cannot be judged here. This is the same
        // "we cannot know what comes next" case `resync` already exists for —
        // the difference being that this one is deliberate.
        resync = true;
        expected = undefined;
        continue;
      }

      resync = false;
      expected = rec.hash;
    }

    return { records: out, integrity: summarise(tally, rotated) };
  }

  /**
   * The last line of the live file, or undefined.
   *
   * Reads a bounded tail rather than the whole file, and widens to a full read
   * when the last record is larger than the window — a message may be up to
   * 100k characters, and chaining onto a truncated fragment would corrupt the
   * chain rather than merely slow it down.
   */
  private lastLine(): string | undefined {
    let fd: number | undefined;
    try {
      const size = statSync(this.path).size;
      if (size === 0) return undefined;
      const want = Math.min(size, 65_536);
      const buf = Buffer.alloc(want);
      fd = openSync(this.path, 'r');
      readSync(fd, buf, 0, want, size - want);
      const chunk = buf.toString('utf8');
      // No newline in the window means the final record starts before it.
      if (want < size && !chunk.includes('\n')) {
        const all = readFileSync(this.path, 'utf8').split('\n').filter((l) => l.trim() !== '');
        return all[all.length - 1];
      }
      const lines = chunk.split('\n').filter((l) => l.trim() !== '');
      return lines[lines.length - 1];
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // closing a read handle cannot fail in a way we can act on
        }
      }
    }
  }

  /**
   * The head to chain onto, read fresh every time.
   *
   * This used to be cached for the life of the process, on the stated grounds
   * that "we are its only writer". That is false: `~/.tincan/messages.jsonl`
   * is machine-global and every live session's Tin Can appends to it — six
   * were writing to it on the machine where this was found. A cached head
   * meant a process that had not written for a while chained onto a record
   * that was no longer last, and the integrity check reported a break that was
   * only interleaving. A chain that cries wolf gets ignored.
   *
   * Two appends that genuinely race can still pick the same head. That is a
   * real limit of an unlocked multi-writer log, and it is far rarer than the
   * stale-cache case this removes.
   */
  private headHash(): string {
    const last = this.lastLine();
    if (last === undefined) return GENESIS;
    try {
      const rec = JSON.parse(last) as LogRecord;
      // A legacy tail has no hash to chain onto, so a new chain starts here
      // rather than the records before it being retrofitted.
      return typeof rec.hash === 'string' ? rec.hash : GENESIS;
    } catch {
      return GENESIS;
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const chained: LogRecord = { ...rec, prev: this.headHash() };
    chained.hash = recordHash(chained as unknown as Record<string, unknown>);
    appendFileSync(this.path, JSON.stringify(chained) + '\n', 'utf8');
    this.rotateIfNeeded();
  }

  /**
   * Move the whole live file into the archive and start a new one.
   *
   * WHOLESALE, and that is the point. The first version kept the most recent
   * records in the live file, which meant reading it and writing part of it
   * back — and this file is machine-global with one writer per live session.
   * An append landing between that read and the rename was destroyed. Losing
   * recent history from `message_log` is a real cost; silently losing another
   * session's messages is not a cost worth paying to avoid it.
   *
   * `renameSync` is what makes this safe: `appendFileSync` opens the path on
   * every call, so a concurrent append either completed into the file being
   * moved or will create the new one. Neither loses a record.
   */
  private rotateIfNeeded(): void {
    if (this.maxBytes <= 0) return;
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;

    // Exclusive-create as a lock: if another session is already rotating,
    // this one simply does not, and will find the file small next time.
    const lock = `${this.path}.rotating`;
    let lockFd: number;
    try {
      lockFd = openSync(lock, 'wx');
    } catch {
      return;
    }

    try {
      if (statSync(this.path).size <= this.maxBytes) return; // lost the race
      const prev = this.headHash();
      const staging = `${this.path}.rotated`;
      renameSync(this.path, staging);

      // Appending staging into the archive is safe in a way rewriting the
      // live file is not: nothing else writes the archive, and nothing else
      // holds the staging path.
      appendFileSync(this.archivePath, readFileSync(staging, 'utf8'), 'utf8');
      const moved = readFileSync(staging, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '').length;
      unlinkSync(staging);

      const checkpoint: LogRecord = {
        id: `cp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        at: new Date().toISOString(),
        kind: 'checkpoint',
        rotated: moved,
        into: basename(this.archivePath),
        prev,
      };
      checkpoint.hash = recordHash(checkpoint as unknown as Record<string, unknown>);
      appendFileSync(this.path, JSON.stringify(checkpoint) + '\n', 'utf8');
    } catch {
      // A failed rotation leaves an oversized log, which is survivable. A
      // half-finished one would not be.
    } finally {
      try {
        closeSync(lockFd);
      } catch {
        // nothing actionable
      }
      try {
        unlinkSync(lock);
      } catch {
        // nothing actionable
      }
    }
  }
}

function isMessage(r: LogRecord): r is MessageRecord {
  return r.kind === undefined;
}

function summarise(t: {
  unparseable: number;
  tampered: number;
  broken: number;
  unchained: number;
}, rotated?: LogIntegrity['rotated']): LogIntegrity {
  const faults: string[] = [];
  if (t.unparseable > 0) {
    faults.push(`${t.unparseable} line(s) could not be parsed (a truncated or half-written write)`);
  }
  if (t.tampered > 0) faults.push(`${t.tampered} record(s) no longer match their own hash`);
  if (t.broken > 0) faults.push(`${t.broken} record(s) do not follow the record before them`);
  const ok = faults.length === 0;
  return {
    ok,
    ...t,
    ...(rotated !== undefined && { rotated }),
    ...(ok
      ? {}
      : {
          detail:
            `Log integrity: ${faults.join('; ')}. Records are still returned, but the log is ` +
            `incomplete or was edited — treat it as a partial account of what happened. The ` +
            `chain detects damage, not a deliberate rewrite by this user.`,
        }),
  };
}
