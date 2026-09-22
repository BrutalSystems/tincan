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
    'Tin Can is a stdio MCP server. It is started by your agent harness, not',
    'usually by hand: point a Claude Code, Codex, or opencode MCP server entry',
    'at this binary and it exposes the peers, send_peer and message_log tools.',
    '',
    'Usage:',
    '  tincan                  run the MCP server on stdio',
    '  tincan --version, -v    print the version and exit',
    '  tincan --help, -h       print this help and exit',
    '',
    'Docs: https://github.com/BrutalSystems/tincan',
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

/** What the process should do, decided from argv alone. */
export type ArgvIntent =
  | { kind: 'serve' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'unknown'; arg: string };

/**
 * Tin Can has no subcommands — it is an MCP server, and its tools are reached
 * through a harness, not a shell. An unrecognised argument is therefore a
 * mistake, and must NOT fall through to starting the server: a server started
 * by `tincan mcp peers list` writes nothing to stdout and exits when its stdin
 * closes, which reads exactly like "the command ran and found no peers".
 * A model that has guessed at a CLI then believes its own invention.
 */
export function classifyArgv(argv: string[]): ArgvIntent {
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
    'tincan is an MCP server, not a command-line tool: it has no subcommands,',
    'and there is no `tincan peers` or `tincan mcp ...`. Peers are listed by',
    'calling the `peers` tool from inside an agent session that has tincan',
    'configured as an MCP server.',
    '',
    "Run 'tincan --help' for the flags it does accept.",
  ].join('\n');
}
