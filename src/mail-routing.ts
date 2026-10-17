/**
 * Direct messages to the seated chief of staff go to its mailbox (#26).
 *
 * The chief of staff is the session holding the seat in
 * `$XDG_STATE_HOME/my-handler/seat` (`<name> <canonical id> <pid>`). Its
 * conversation is with Mike, and every tincan message to it lands as a turn in
 * that conversation — worker refusals, DONE reports, a Scotty handoff all cut
 * in on him. Its mailbox, `cos-mail`, exists so they do not: the chief of staff
 * reads mail when it is ready. So a message addressed to that session is filed
 * there instead of delivered, with three exceptions that are delivered as
 * always:
 *
 *  - text starting `SCOTTY-` or `HANDOFF-`: the handoff protocol, which is
 *    time-critical and is answered by the receiving session itself;
 *  - a reply to a message the chief of staff sent with `expect_reply`: it asked,
 *    and is waiting on the answer;
 *  - cos-mail's own ping (an external `tincan send --from cos-mail`), which is
 *    how urgent mail reaches the session at all — mailing it would loop.
 *
 * An urgent message is mailed as urgent, and cos-mail sends its one-line
 * "mail: N urgent — cos-mail read" ping, which comes back through here and is
 * delivered by the last exception.
 *
 * cos-mail is CALLED, not imitated. It appends under an `fcntl.flock` on
 * `mail.jsonl.lock`, which Node cannot take, and it also keeps the activity feed
 * and the ledger. Writing the line ourselves would mean racing it. Any failure
 * to file — no cos-mail on PATH, a refusal, a timeout — falls back to delivering
 * the message as before: a message must never be lost to the router.
 *
 * The seat is read on every send, so it follows a restart or a handoff without
 * anyone telling Tin Can. No seat file means nobody is seated: delivered.
 *
 * Off switch, either: `TINCAN_MAIL_ROUTING=off` in the environment, or a file
 * named `mail-routing-off` in `$TINCAN_HOME` (`~/.tincan`). The file needs no
 * restart, which is what an undo wants.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the router needs to know about the chief of staff. */
export interface Seat {
  name: string;
  canonicalId: string;
  /** The durable id: the canonical id's part after the last `.`. */
  id: string;
}

/** One mail item, in cos-mail's terms. */
export interface MailItem {
  /** cos-mail's `<stream-or-session>`: the sender's session id, else its name. */
  to: string;
  kind: MailKind;
  text: string;
  from: string;
  sessionId?: string;
  replyTo?: string;
  urgent: boolean;
  /** So a retried send files one item, not two. */
  key: string;
}

export type FileResult = { ok: true; mailId?: string } | { ok: false; error: string };

export interface MailRouting {
  /** The seated chief of staff, or undefined when nobody is seated or routing is off. */
  seat(): Seat | undefined;
  file(item: MailItem): Promise<FileResult>;
}

/** The kinds a message may file as. REQUEST and ALERT are not inferred: they mean other things. */
export const MAIL_KINDS = ['STARTED', 'STATUS', 'BLOCKED', 'DECISION', 'DONE', 'STOPPED'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/**
 * A message that opens with a report kind files as that kind — "DONE: PR #12
 * merged" is a DONE — and anything else as STATUS, cos-mail's progress note.
 */
export function kindOf(text: string): MailKind {
  const m = /^\s*([A-Z]+)\b/.exec(text);
  const word = m?.[1];
  return (MAIL_KINDS as readonly string[]).includes(word ?? '') ? (word as MailKind) : 'STATUS';
}

/** The handoff protocol's prefixes. Delivered: a mailbox is read too late for them. */
export const PROTOCOL_PREFIXES = ['SCOTTY-', 'HANDOFF-'] as const;

/** The name cos-mail sends its urgent ping under. */
export const COS_MAIL_SENDER = 'cos-mail';

export interface RouteQuestion {
  seat: Seat | undefined;
  /** The recipient's durable id. */
  targetId: string;
  text: string;
  /** Who is sending: `external` with this name is the `tincan send` CLI. */
  fromRuntime: string;
  fromName: string;
  /** The message `in_reply_to` names, when it is in the log. */
  original?: { fromId?: string; expectReply: boolean };
}

/** Mailbox or straight through? `true` means mailbox. */
export function routesToMailbox(q: RouteQuestion): boolean {
  if (q.seat === undefined || q.targetId !== q.seat.id) return false;
  const text = q.text.trimStart();
  if (PROTOCOL_PREFIXES.some((p) => text.startsWith(p))) return false;
  if (q.original !== undefined && q.original.expectReply && q.original.fromId === q.seat.id) {
    return false;
  }
  if (q.fromRuntime === 'external' && q.fromName === COS_MAIL_SENDER) return false;
  return true;
}

export function parseSeat(contents: string): Seat | undefined {
  const [name, canonicalId] = contents.split(/\s+/).filter(Boolean);
  if (name === undefined || canonicalId === undefined) return undefined;
  const dot = canonicalId.lastIndexOf('.');
  if (dot < 0 || dot === canonicalId.length - 1) return undefined;
  return { name, canonicalId, id: canonicalId.slice(dot + 1) };
}

/** Whether the off switch is thrown. */
export function routingOff(env: NodeJS.ProcessEnv, home: string = homedir()): boolean {
  const v = (env.TINCAN_MAIL_ROUTING ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(v)) return true;
  return existsSync(join(env.TINCAN_HOME ?? join(home, '.tincan'), 'mail-routing-off'));
}

export function seatPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'my-handler', 'seat');
}

/** cos-mail's argv for one item. */
export function cosMailArgs(item: MailItem): string[] {
  return [
    'send',
    item.to,
    item.kind,
    item.text,
    '--from',
    item.from,
    ...(item.sessionId !== undefined ? ['--session-id', item.sessionId] : []),
    ...(item.replyTo !== undefined ? ['--reply-to', item.replyTo] : []),
    '--key',
    item.key,
    ...(item.urgent ? ['--urgent'] : []),
  ];
}

/** The real router: the seat file on disk, the `cos-mail` on PATH (or `$TINCAN_COS_MAIL`). */
export function mailRoutingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): MailRouting {
  return {
    seat() {
      if (routingOff(env, home)) return undefined;
      try {
        return parseSeat(readFileSync(seatPath(env, home), 'utf8'));
      } catch {
        return undefined;
      }
    },
    file(item) {
      const bin = env.TINCAN_COS_MAIL || 'cos-mail';
      return new Promise((resolve) => {
        execFile(bin, cosMailArgs(item), { timeout: 20_000 }, (err, stdout, stderr) => {
          if (err) {
            const why = String(stderr || err.message).trim().split('\n').pop() ?? '';
            resolve({ ok: false, error: `${bin}: ${why.slice(0, 200)}` });
            return;
          }
          const m = /mail #(\d+)/.exec(String(stdout));
          resolve({ ok: true, ...(m?.[1] !== undefined && { mailId: m[1] }) });
        });
      });
    },
  };
}
