/**
 * Direct messages to a configured recipient go to a configured mailbox (#26).
 *
 * Some setups have one session that should not be interrupted by every message
 * addressed to it — a session in conversation with a human, say, where each
 * Tin Can message would otherwise land as a turn in that conversation. For
 * that session, Tin Can can file messages with an inbox command instead of
 * delivering them, and the session reads its mailbox when it is ready.
 *
 * Both halves come from configuration (`$TINCAN_HOME/mail-routing.json`):
 *
 *  - the **recipient file** names the session, as `<name> <canonical id>` and
 *    anything after. Default `$TINCAN_HOME/mail-recipient`.
 *  - the **inbox command** files one message. Default `tincan-mailbox` on PATH.
 *
 * With no recipient file nobody is a recipient, so by default nothing changes.
 * A message addressed to the recipient is filed instead of delivered, with
 * three exceptions that are delivered as always:
 *
 *  - text starting with one of `deliverPrefixes` (none by default): for
 *    protocols that are time-critical and answered by the session itself;
 *  - a reply to a message the recipient sent with `expect_reply`: it asked,
 *    and is waiting on the answer;
 *  - the inbox command's own notification (an external `tincan send --from
 *    <commandSender>`), which is how urgent mail reaches the session at all —
 *    mailing it would loop.
 *
 * An urgent message is filed as urgent, and the inbox command is expected to
 * notify the recipient, which comes back through here and is delivered by the
 * last exception. If it reports no notification, the message is delivered
 * directly as well: urgent mail nobody is told about is not urgent.
 *
 * The inbox command is CALLED, not imitated: it owns its storage and its
 * locking. Any failure to file — no such command, a refusal, a timeout — falls
 * back to delivering the message as before: a message must never be lost to
 * the router.
 *
 * Configuration and the recipient file are read on every send, so routing
 * follows a restart or a handoff without anyone telling Tin Can.
 *
 * Off switch, either: `TINCAN_MAIL_ROUTING=off` in the environment, or a file
 * named `mail-routing-off` in `$TINCAN_HOME` (`~/.tincan`). The file needs no
 * restart, which is what an undo wants.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** What the router needs to know about the recipient. */
export interface Recipient {
  name: string;
  canonicalId: string;
  /** The durable id: the canonical id's part after the last `.`. */
  id: string;
}

/** One mail item, as the inbox command is given it. */
export interface MailItem {
  /** The sender's stream: its session id, else its name. */
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

/**
 * `notified` is set for urgent mail only: whether the inbox command reported
 * notifying the recipient. False means filed but not announced, so the caller
 * delivers it too.
 */
export type FileResult =
  | { ok: true; mailId?: string; notified?: boolean }
  | { ok: false; error: string };

export interface MailRouting {
  /** The configured recipient, or undefined when there is none or routing is off. */
  recipient(): Recipient | undefined;
  /** How the inbox command is named in notices. */
  commandName(): string;
  /** Text starting with one of these is delivered, not filed. */
  deliverPrefixes(): readonly string[];
  /** The external sender name the inbox command notifies under; always delivered. */
  commandSender(): string;
  file(item: MailItem): Promise<FileResult>;
}

/** The kinds a message may file as. REQUEST and ALERT are not inferred: they mean other things. */
export const MAIL_KINDS = ['STARTED', 'STATUS', 'BLOCKED', 'DECISION', 'DONE', 'STOPPED'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/**
 * A message that opens with a report kind files as that kind — "DONE: PR #12
 * merged" is a DONE — and anything else as STATUS, a progress note.
 */
export function kindOf(text: string): MailKind {
  const m = /^\s*([A-Z]+)\b/.exec(text);
  const word = m?.[1];
  return (MAIL_KINDS as readonly string[]).includes(word ?? '') ? (word as MailKind) : 'STATUS';
}

export interface RouteQuestion {
  recipient: Recipient | undefined;
  /** The addressee's durable id. */
  targetId: string;
  text: string;
  /** Who is sending: `external` with this name is the `tincan send` CLI. */
  fromRuntime: string;
  fromName: string;
  /** The message `in_reply_to` names, when it is in the log. */
  original?: { fromId?: string; expectReply: boolean };
  deliverPrefixes: readonly string[];
  commandSender: string;
}

/** Mailbox or straight through? `true` means mailbox. */
export function routesToMailbox(q: RouteQuestion): boolean {
  if (q.recipient === undefined || q.targetId !== q.recipient.id) return false;
  const text = q.text.trimStart();
  if (q.deliverPrefixes.some((p) => p.length > 0 && text.startsWith(p))) return false;
  if (q.original !== undefined && q.original.expectReply && q.original.fromId === q.recipient.id) {
    return false;
  }
  if (q.fromRuntime === 'external' && q.fromName === q.commandSender) return false;
  return true;
}

export function parseRecipient(contents: string): Recipient | undefined {
  const [name, canonicalId] = contents.split(/\s+/).filter(Boolean);
  if (name === undefined || canonicalId === undefined) return undefined;
  const dot = canonicalId.lastIndexOf('.');
  if (dot < 0 || dot === canonicalId.length - 1) return undefined;
  return { name, canonicalId, id: canonicalId.slice(dot + 1) };
}

/** Tin Can's home: `$TINCAN_HOME`, else `~/.tincan`. */
export function tincanHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env.TINCAN_HOME && env.TINCAN_HOME.length > 0 ? env.TINCAN_HOME : join(home, '.tincan');
}

/** Whether the off switch is thrown. */
export function routingOff(env: NodeJS.ProcessEnv, home: string = homedir()): boolean {
  const v = (env.TINCAN_MAIL_ROUTING ?? '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(v)) return true;
  return existsSync(join(tincanHome(env, home), 'mail-routing-off'));
}

/** The settings, after defaults. */
export interface MailRoutingConfig {
  recipientFile: string;
  command: string;
  commandSender: string;
  deliverPrefixes: string[];
}

export const DEFAULT_COMMAND = 'tincan-mailbox';

export function configPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env.TINCAN_MAIL_ROUTING_CONFIG || join(tincanHome(env, home), 'mail-routing.json');
}

const expandHome = (p: string, home: string): string =>
  p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;

/**
 * Reads the configuration, filling in defaults. A missing file is all
 * defaults; an unreadable or malformed one is too, rather than a throw on
 * every send — and with the default recipient file absent, that means off.
 */
export function readConfig(env: NodeJS.ProcessEnv, home: string = homedir()): MailRoutingConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(env, home), 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    /* defaults */
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const command = str(raw.command) ?? DEFAULT_COMMAND;
  return {
    recipientFile: expandHome(str(raw.recipientFile) ?? join(tincanHome(env, home), 'mail-recipient'), home),
    command: expandHome(command, home),
    commandSender: str(raw.commandSender) ?? basename(command),
    deliverPrefixes: Array.isArray(raw.deliverPrefixes)
      ? raw.deliverPrefixes.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [],
  };
}

/** The inbox command's argv for one item. */
export function inboxCommandArgs(item: MailItem): string[] {
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

/** The real router: configuration and the recipient file on disk, read on every call. */
export function mailRoutingFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): MailRouting {
  const config = (): MailRoutingConfig => readConfig(env, home);
  return {
    recipient() {
      if (routingOff(env, home)) return undefined;
      try {
        return parseRecipient(readFileSync(config().recipientFile, 'utf8'));
      } catch {
        return undefined;
      }
    },
    commandName: () => basename(config().command),
    deliverPrefixes: () => config().deliverPrefixes,
    commandSender: () => config().commandSender,
    async file(item) {
      const bin = config().command;
      const label = basename(bin);
      const run = (): Promise<FileResult> =>
        new Promise((resolve) => {
          execFile(bin, inboxCommandArgs(item), { timeout: 10_000 }, (err, stdout, stderr) => {
            if (err) {
              const why = String(stderr || err.message).trim().split('\n').pop() ?? '';
              resolve({ ok: false, error: `${label}: ${why.slice(0, 200)}` });
              return;
            }
            const out = String(stdout);
            const m = /mail #(\d+)/.exec(out);
            resolve({
              ok: true,
              ...(m?.[1] !== undefined && { mailId: m[1] }),
              // Exit 0 does not say the notification landed; only a "notified " or
              // "pinged " line does.
              ...(item.urgent && { notified: /^(?:notified|pinged) /m.test(out) }),
            });
          });
        });
      // Once more under the same --key: a first try that filed the item and then
      // stalled (on its notification, say) answers "already sent" rather than
      // filing it twice, so a timeout is not mistaken for nothing filed.
      const first = await run();
      return first.ok ? first : run();
    },
  };
}
