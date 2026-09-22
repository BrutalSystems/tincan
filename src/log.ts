/** Append-only JSONL message log (§9). Written before delivery is attempted. */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
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
export const ROTATE_KEEP_RECORDS = 500;

export interface LogOptions {
  /** Rotate once the live file exceeds this. 0 disables rotation entirely. */
  maxBytes?: number;
  /** How many of the most recent records stay in the live file. */
  keepRecords?: number;
}

export class MessageLog {
  private readonly maxBytes: number;
  private readonly keepRecords: number;

  constructor(
    private readonly path: string,
    opts: LogOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? ROTATE_MAX_BYTES;
    this.keepRecords = opts.keepRecords ?? ROTATE_KEEP_RECORDS;
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
        const folded =
          o === undefined
            ? r
            : { ...r, delivered: o.delivered, ...(o.detail !== undefined && { notice: o.detail }) };
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
   * The head this process will chain onto. Cached after the first read: the
   * log is append-only and we are its only writer, so re-reading the file on
   * every append would be pure cost.
   */
  private head: string | undefined;

  private headHash(): string {
    if (this.head !== undefined) return this.head;
    if (!existsSync(this.path)) return (this.head = GENESIS);
    const lines = readFileSync(this.path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const last = lines[lines.length - 1];
    if (last === undefined) return (this.head = GENESIS);
    try {
      const rec = JSON.parse(last) as LogRecord;
      // A legacy tail has no hash to chain onto, so a new chain starts here
      // rather than the records before it being retrofitted.
      return (this.head = typeof rec.hash === 'string' ? rec.hash : GENESIS);
    } catch {
      return (this.head = GENESIS);
    }
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const chained: LogRecord = { ...rec, prev: this.headHash() };
    chained.hash = recordHash(chained as unknown as Record<string, unknown>);
    appendFileSync(this.path, JSON.stringify(chained) + '\n', 'utf8');
    this.head = chained.hash;
    this.rotateIfNeeded();
  }

  /**
   * Move all but the most recent records into the archive, leaving a chained
   * checkpoint at the head of the live file.
   *
   * Note what the checkpoint does and does not buy, because the obvious
   * rationale is wrong. Plain truncation would NOT be reported as damage: the
   * first record in a file is never link-judged, so a headless live file
   * verifies clean. What truncation loses is the evidence — a caller sees a
   * short log with nothing to say why, and the archive is no longer provably
   * the same chain. The checkpoint buys that evidence, and costs the resync
   * handling in `allWithIntegrity`.
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

    const lines = readFileSync(this.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    if (lines.length <= this.keepRecords) return;

    const archived = lines.slice(0, lines.length - this.keepRecords);
    const kept = lines.slice(lines.length - this.keepRecords);

    // Chain the checkpoint onto the last record leaving the file. A damaged
    // tail chains from genesis rather than aborting the rotation: the file is
    // already over budget, and refusing to rotate would make that permanent.
    let prev = GENESIS;
    try {
      const last = JSON.parse(archived[archived.length - 1]!) as LogRecord;
      if (typeof last.hash === 'string') prev = last.hash;
    } catch {
      // keep GENESIS
    }

    const checkpoint: LogRecord = {
      id: `cp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      at: new Date().toISOString(),
      kind: 'checkpoint',
      rotated: archived.length,
      into: basename(this.archivePath),
      prev,
    };
    checkpoint.hash = recordHash(checkpoint as unknown as Record<string, unknown>);

    // Archive first: a crash between the two leaves records duplicated in both
    // files, which is recoverable. The other order loses them.
    appendFileSync(this.archivePath, archived.join('\n') + '\n', 'utf8');

    // Temp-then-rename, so a reader never sees a half-written live file.
    const tmp = `${this.path}.rotating`;
    writeFileSync(tmp, [JSON.stringify(checkpoint), ...kept].join('\n') + '\n', 'utf8');
    renameSync(tmp, this.path);
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
