/** Append-only JSONL message log (§9). Written before delivery is attempted. */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export type LogRecord = MessageRecord | NoticeRecord | DroppedRecord | OutcomeRecord;

export interface ReadQuery {
  peer?: string;
  thread?: string;
  last_n: number;
}

export function messagesPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(env.TINCAN_HOME ?? join(home, '.tincan'), 'messages.jsonl');
}

export class MessageLog {
  constructor(private readonly path: string) {}

  appendMessage(e: Envelope, delivered: boolean): MessageRecord {
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

  read(query: ReadQuery): LogRecord[] {
    let records = this.fold(this.all());

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

    return records.slice(-query.last_n);
  }

  /** Applies outcome records to their message and drops them from the result. */
  private fold(records: LogRecord[]): LogRecord[] {
    const outcomes = new Map<string, OutcomeRecord>();
    for (const r of records) if (r.kind === 'outcome') outcomes.set(r.id, r);

    return records
      .filter((r) => r.kind !== 'outcome')
      .map((r) => {
        const o = isMessage(r) ? outcomes.get(r.id) : undefined;
        if (o === undefined) return r;
        return { ...r, delivered: o.delivered, ...(o.detail !== undefined && { notice: o.detail }) };
      });
  }

  private all(): LogRecord[] {
    if (!existsSync(this.path)) return [];
    const out: LogRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as LogRecord);
      } catch {
        // A truncated or hand-edited line must not cost us the rest of the log.
      }
    }
    return out;
  }

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf8');
  }
}

function isMessage(r: LogRecord): r is MessageRecord {
  return r.kind === undefined;
}
