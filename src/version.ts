/**
 * The one place the running program learns its own version.
 *
 * Read from package.json at startup rather than hardcoded: a literal here is a
 * fifth place a release has to remember, and the four that already exist are
 * kept honest by tests. This one cannot drift.
 *
 * `dist/version.js` sits one directory below the package root, and
 * package.json ships in the tarball, so the relative path holds both in the
 * repo and in an installed copy.
 */
import { readFileSync } from 'node:fs';

function read(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json has no version');
  }
  return pkg.version;
}

export const VERSION = read();

/** Text for `--version`. */
export function versionLine(): string {
  return `tincan ${VERSION}`;
}

/** Text for `--help`. Goes to stdout only when the server is NOT starting. */
export function helpText(): string {
  return [
    `tincan ${VERSION} — peer messaging between live coding-agent sessions`,
    '',
    'Tin Can is mainly a stdio MCP server, started by your agent harness rather',
    'than by hand: point a Claude Code, Codex, or opencode MCP server entry at',
    'this binary and it exposes the peers, send_peer and message_log tools.',
    '',
    '`send` is the exception, for a program that is not an agent session and has',
    'no harness to host an MCP server. It reaches all three runtimes.',
    '',
    'Usage:',
    '  tincan                  run the MCP server on stdio',
    '  tincan send ...         deliver one message to one peer, then exit',
    '  tincan --version, -v    print the version and exit',
    '  tincan --help, -h       print this help and exit',
    '',
    sendHelpText(),
    '',
    'Docs: https://github.com/BrutalSystems/tincan',
  ].join('\n');
}

/**
 * The `send` section, which is also what `tincan send --help` prints on its own.
 *
 * One source rather than two copies: `send --help` exists so that a caller can
 * ask whether this build can send at all, and a probe that is answered by prose
 * which has drifted from the real `--help` is worse than no probe. The
 * help/argv parity test in `version.test.ts` reads whichever of the two it
 * likes and gets the same answer.
 */
export function sendHelpText(): string {
  return [
    'send:',
    '  tincan send --to <peer> --from <name> --message <text>',
    '              [--idempotency-key <key>] [--reply-via <how to answer>]',
    '',
    '  --to              the peer, as `peers` names it',
    '  --from            who is sending, lowercase letters, digits and hyphens.',
    '                    Refused, never rewritten: a silently changed sender name',
    '                    is an address recipients cannot reply to.',
    '  --message         the text to deliver',
    '  --idempotency-key a later retry under the same key will not send twice,',
    '                    for 10 minutes. Not exactly-once: two invocations racing',
    '                    each other can both send, and a key that ages out will',
    '                    deliver again.',
    '  --reply-via       how to answer, for a sender with no inbox of its own',
    '  --help, -h        print this and exit 0. A build without `send` exits',
    '                    non-zero here, so the exit code is a capability check.',
    '',
    '  Writes one line of JSON to stdout — {outcome, refusal, message_id,',
    '  peer_state} — on every exit code, including a failure. Read `refusal`',
    '  rather than the exit code: 0 accepted, 2 rejected, 1 failed, 64 bad usage.',
    '  `accepted` means the peer\'s harness took the message, NOT that it was',
    '  read or acted on. Diagnostics go to stderr.',
  ].join('\n');
}

/**
 * Every flag the CLI accepts. The single source of truth for what
 * `classifyArgv` recognises, so that `version.test.ts` can assert `helpText`
 * documents all of them and invents none — `-v` and `-h` were accepted but
 * undocumented until that test was written.
 */
export const FLAGS: ReadonlyArray<{
  readonly flags: readonly string[];
  readonly kind: 'version' | 'help';
}> = [
  { flags: ['--version', '-v'], kind: 'version' },
  { flags: ['--help', '-h'], kind: 'help' },
];

/**
 * The one subcommand. Named here rather than inline so `unknownArgText` and the
 * help/argv parity test cannot disagree with the dispatcher about what exists.
 */
export const SUBCOMMANDS = ['send'] as const;

/** What the process should do, decided from argv alone. */
export type ArgvIntent =
  | { kind: 'serve' }
  | { kind: 'version' }
  | { kind: 'help' }
  /** `send`'s own arguments, parsed by send-cli rather than here. */
  | { kind: 'send'; argv: string[] }
  | { kind: 'unknown'; arg: string };

/**
 * Tin Can has exactly one subcommand, and everything else is still refused.
 *
 * The rule this function was written to enforce has not changed: an
 * unrecognised argument must NOT fall through to starting the server, because a
 * server started by `tincan mcp peers list` writes nothing to stdout and exits
 * when its stdin closes, which reads exactly like "the command ran and found no
 * peers" — and a model that has guessed at a CLI then believes its own
 * invention.
 *
 * What changed is narrower than it looks. `send` exists because one caller
 * cannot be served by the MCP doorway at all: a program with no harness has
 * nothing to host a stdio server. That is a real gap rather than a guess, and
 * admitting one named subcommand does not admit guessed ones — `tincan peers`
 * is still refused, and refused with the same text as before.
 */
export function classifyArgv(argv: string[]): ArgvIntent {
  if (argv[0] === 'send') return { kind: 'send', argv: argv.slice(1) };
  for (const arg of argv) {
    for (const flag of FLAGS) {
      if (flag.flags.includes(arg)) return { kind: flag.kind };
    }
    return { kind: 'unknown', arg };
  }
  return { kind: 'serve' };
}

/** What to print on stderr when argv makes no sense. */
export function unknownArgText(arg: string): string {
  return [
    `tincan: unrecognised argument '${arg}'`,
    '',
    'tincan is an MCP server with one subcommand, `tincan send`. There is no',
    '`tincan peers` and no `tincan mcp ...`. Peers are listed by calling the',
    '`peers` tool from inside an agent session that has tincan configured as an',
    'MCP server; sending is the one thing that also works from outside.',
    '',
    `Subcommands: ${SUBCOMMANDS.join(', ')}.`,
    "Run 'tincan --help' for the flags it accepts.",
  ].join('\n');
}
