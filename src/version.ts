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
    '  tincan              run the MCP server on stdio',
    '  tincan --version    print the version and exit',
    '  tincan --help       print this help and exit',
    '',
    'Docs: https://github.com/BrutalSystems/tincan',
  ].join('\n');
}
