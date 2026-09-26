/**
 * `tincan send` — the call surface for a process that is not an agent session.
 *
 * Tin Can's README has always said the MCP doorway is incidental: "it could be
 * a CLI or a slash command without changing anything that matters." This is
 * that CLI, and it exists for one reason a harness cannot serve — reaching Tin
 * Can from a program that has no harness at all. Its first caller is birddog,
 * a Go binary that was otherwise hand-rolling Claude Code's unpublished inbox
 * wire format, pinned to one Claude version, in a second repository.
 *
 * Two constraints shape everything here, and both come from that caller rather
 * than from taste:
 *
 *  1. The reader is not a language model. It parses one line of JSON and
 *     branches on a field. So prose is never the carrier of a distinction —
 *     `detail` exists for humans and nothing in the contract requires reading
 *     it.
 *  2. A non-zero exit still prints the line. If JSON appeared only on success,
 *     a caller could not tell `peer_unknown` (look at your configuration) from
 *     `delivery_failed` (retry the transport), and those want opposite
 *     responses.
 *
 * `--from` is validated, never repaired. See `parseSendArgs`.
 */
import { slugify } from './naming.js';
import { sendHelpText } from './version.js';
import type { Outcome, SendPeerResult } from './tools.js';

/**
 * The longest `--from` accepted.
 *
 * Generous on purpose — it is a bound against a name that is obviously not a
 * name, not an opinion about how senders should be spelled. birddog's instance
 * ids are 15 characters.
 */
export const MAX_FROM_LENGTH = 64;

/**
 * A malformed command line, kept out of the outcome codes.
 *
 * 64 is `EX_USAGE` from sysexits.h. It matters that this is not 1 or 2: those
 * mean a send was attempted or refused and carry a JSON line describing it,
 * whereas this means nothing was attempted, there is no message id, and no
 * value in the `Refusal` enum describes the situation. A caller that saw a
 * usage error as `failed` would retry a command line that can never work.
 */
export const USAGE_EXIT = 64;

export interface SendCliArgs {
  to: string;
  from: string;
  message: string;
  idempotencyKey?: string;
  replyVia?: string;
}

/**
 * `help: true` carries no `args` — nothing was asked to be sent. It is a
 * separate shape rather than a flag on a normal parse so that a caller cannot
 * reach for `args` on a help request and get a half-built send.
 */
export type SendCliParse =
  | { ok: true; help: true; args?: undefined }
  | { ok: true; help?: undefined; args: SendCliArgs }
  | { ok: false; error: string };

/** `--help` and `-h`, which `send` answers itself rather than passing upward. */
const HELP_FLAGS = ['--help', '-h'] as const;

/** Every flag `send` takes, and whether it must be present. */
const SEND_OPTIONS = [
  { flag: '--to', key: 'to', required: true },
  { flag: '--from', key: 'from', required: true },
  { flag: '--message', key: 'message', required: true },
  { flag: '--idempotency-key', key: 'idempotencyKey', required: false },
  { flag: '--reply-via', key: 'replyVia', required: false },
] as const;

/** The flag tokens, for the help/argv parity check in version.ts. */
export const SEND_FLAGS: readonly string[] = SEND_OPTIONS.map((o) => o.flag);

/**
 * Parse `send`'s arguments, refusing anything it does not understand.
 *
 * Unknown flags are refused rather than ignored for the reason `classifyArgv`
 * refuses unknown arguments one level up: a silently dropped `--urgent` reads
 * to the caller as an urgent message that was delivered. The same goes for a
 * flag with no value, which would otherwise consume the next flag as its
 * argument and produce a message of "--from".
 */
export function parseSendArgs(argv: string[]): SendCliParse {
  const found = new Map<string, string>();

  /**
   * Checked before anything else, and deliberately across the whole of argv.
   *
   * This is a capability probe as much as a help request: a caller asking
   * whether `send` exists cannot be expected to supply `--to` and `--message`
   * in order to ask. So `--help` must beat every other complaint this function
   * can make, including the required-flag check below.
   *
   * Scanning positions rather than parsing pairs means `--message --help` reads
   * as help, not as a message of "--help" — which is the right way round: the
   * loop below would refuse that as a flag without a value anyway, and a real
   * message containing the word is passed as one argument and never seen here.
   */
  if (argv.some((a) => (HELP_FLAGS as readonly string[]).includes(a))) {
    return { ok: true, help: true };
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const option = SEND_OPTIONS.find((o) => o.flag === token);
    if (option === undefined) {
      return {
        ok: false,
        error:
          `tincan send: unrecognised argument '${token}'. ` +
          `Accepted: ${SEND_FLAGS.join(', ')}.`,
      };
    }
    const value = argv[i + 1];
    // A flag at the end of argv, or one followed by another flag, was given no
    // value. Treating the next flag as the value is the quiet failure.
    if (value === undefined || SEND_FLAGS.includes(value)) {
      return { ok: false, error: `tincan send: ${token} needs a value.` };
    }
    if (found.has(option.key)) {
      return { ok: false, error: `tincan send: ${token} was given more than once.` };
    }
    found.set(option.key, value);
    i += 1;
  }

  for (const option of SEND_OPTIONS) {
    if (option.required && !found.has(option.key)) {
      return { ok: false, error: `tincan send: ${option.flag} is required.` };
    }
  }

  const message = found.get('message')!;
  if (message === '') {
    // A blank alert is worse than no alert: it wakes a session with nothing to
    // act on, and the sender has no way to tell that is what it did.
    return { ok: false, error: 'tincan send: --message is empty, so there is nothing to send.' };
  }

  const from = found.get('from')!;
  const fromError = validateFrom(from);
  if (fromError !== undefined) return { ok: false, error: fromError };

  const idempotencyKey = found.get('idempotencyKey');
  const replyVia = found.get('replyVia');
  return {
    ok: true,
    args: {
      to: found.get('to')!,
      from,
      message,
      ...(idempotencyKey !== undefined && { idempotencyKey }),
      ...(replyVia !== undefined && { replyVia }),
    },
  };
}

/**
 * Why `--from` is refused rather than slugified.
 *
 * The value becomes the envelope's `from=`, and a peer listing slugifies every
 * name it shows (`assignNames`), so a `from=` that is not already slug-shaped
 * is an address nobody can type back — issue #40, on the Claude arm, where a
 * session called `Auth Refactor` announced a name that `resolvePeer` then
 * refused. Repairing it here would reproduce that silently: the caller passes
 * one name, recipients see another, and nothing reports the substitution.
 *
 * So the rule is that `--from` must already be what slugify would produce. A
 * sender that wants a different name can pick one; it cannot be given one.
 */
function validateFrom(from: string): string | undefined {
  if (from === '') return 'tincan send: --from is empty.';
  if (from.length > MAX_FROM_LENGTH) {
    return (
      `tincan send: --from is ${from.length} characters, and the limit is ` +
      `${MAX_FROM_LENGTH}. Shorten it rather than letting it be truncated.`
    );
  }
  const slug = slugify(from);
  if (slug !== from) {
    return (
      `tincan send: --from "${from}" is not a usable address. It must already be ` +
      `lowercase letters, digits and single hyphens, with no leading or trailing ` +
      `hyphen — "${slug}" would work. It is not rewritten for you, because a ` +
      `sender name that is silently changed is a wrong address that looks right: ` +
      `recipients would see a name you never chose and could not reply to it.`
    );
  }
  return undefined;
}

/**
 * The exit code for an outcome.
 *
 * Three codes for three outcomes, and nothing finer: the `Refusal` vocabulary
 * is already wider than the useful exit space and grows, so it travels in the
 * JSON line instead. A caller should read `refusal`; the code is here so that
 * shell usage — `tincan send ... || echo failed` — means something.
 */
export function exitCodeFor(outcome: Outcome): number {
  switch (outcome) {
    case 'accepted':
      return 0;
    case 'failed':
      return 1;
    case 'rejected':
      return 2;
  }
}

/**
 * The single line of JSON written to stdout.
 *
 * Narrow on purpose. These four fields are what the calling contract promises,
 * and everything else `send_peer` returns is deliberately left out: `detail` and
 * `notice` are prose for humans, and a caller that came to depend on them would
 * be depending on wording we change freely. `method` is our implementation.
 *
 * Absent fields are omitted rather than set to null, because `json.Unmarshal`
 * into a Go string turns null into "", which reads as a refusal code of "" —
 * indistinguishable, to a switch, from a refusal that was never there.
 */
export function sendCliLine(result: SendPeerResult): string {
  const line: Record<string, unknown> = {};
  if (result.outcome !== undefined) line.outcome = result.outcome;
  if (result.refusal !== undefined) line.refusal = result.refusal;
  if (result.message_id !== undefined) line.message_id = result.message_id;
  if (result.peer_state !== undefined) line.peer_state = result.peer_state;
  return JSON.stringify(line);
}

/**
 * Run one `send`, write exactly one line to stdout, and answer with an exit
 * code.
 *
 * stdout discipline is the whole reason this is a separate entry point from the
 * server. §8.1 forbids writing to stdout because it is the MCP transport — but
 * no transport is ever connected on this path, the same licence `--version`
 * already relies on. Nothing else may write there: a diagnostic on stdout would
 * put a second line in front of a caller doing one `json.Unmarshal`.
 */
export async function runSend(
  argv: string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    send: (args: SendCliArgs) => Promise<SendPeerResult>;
  },
): Promise<number> {
  const parsed = parseSendArgs(argv);
  if (parsed.ok && parsed.help === true) {
    // Zero, and on stdout. A build without the subcommand cannot reach this
    // line — `send` is an unrecognised argument there and exits non-zero — so
    // the exit code is a capability answer that no rewording can take away.
    io.stdout(`${sendHelpText()}\n`);
    return 0;
  }
  if (!parsed.ok) {
    // No JSON here, deliberately. Nothing was attempted, so there is no
    // outcome, no message id and no Refusal that describes this — and a line
    // shaped like a send result would invite a caller to branch on a send that
    // never happened. USAGE_EXIT is what says so.
    io.stderr(`${parsed.error}\n`);
    return USAGE_EXIT;
  }

  let result: SendPeerResult;
  try {
    result = await io.send(parsed.args);
  } catch (e) {
    // An exception here is ours, not the caller's, and it still has to arrive
    // as a parseable line: a caller that gets no JSON cannot tell a crash from
    // a peer that refused, and would have to treat both as unknown.
    io.stderr(`tincan send: ${e instanceof Error ? e.message : String(e)}\n`);
    io.stdout(`${JSON.stringify({ outcome: 'failed', refusal: 'delivery_failed' })}\n`);
    return exitCodeFor('failed');
  }

  io.stdout(`${sendCliLine(result)}\n`);
  if (result.detail !== undefined) io.stderr(`${result.detail}\n`);
  // A single recipient always carries an outcome; `outcome` is optional on the
  // type only because a fan-out reports per recipient instead, and `send` has
  // no fan-out. Treated as failed rather than assumed, because guessing
  // `accepted` would be the one wrong direction to guess in.
  return exitCodeFor(result.outcome ?? 'failed');
}
