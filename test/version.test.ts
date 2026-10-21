import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  VERSION,
  versionLine,
  helpText,
  classifyArgv,
  unknownArgText,
  FLAGS,
  SUBCOMMANDS,
} from '../src/version.js';
import { INBOX_FLAGS } from '../src/inbox-cli.js';
import { SEND_FLAGS } from '../src/send-cli.js';
import { MCP_FLAGS, MCP_ACTIONS, parseMcpArgs } from '../src/mcp-cli.js';

describe('version', () => {
  // The fifth version location. package.json, the canonical-id fixture and the
  // opencode plugin constant are each pinned by a test; this one reported
  // 0.1.0 to every MCP client from 0.1.0 through 0.5.3 because nothing checked.
  it('reports the package version, not a literal that drifts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe('0.1.0');
  });

  it('formats a version line', () => {
    expect(versionLine()).toBe(`tincan ${VERSION}`);
  });

  it('names the version and all three runtimes in help', () => {
    const h = helpText();
    expect(h).toContain(VERSION);
    expect(h).toContain('--version');
    expect(h).toContain('opencode');
  });

  // A model that believes tincan has a CLI will invent one. Starting the MCP
  // server in response to `tincan mcp peers list` produces an empty stdout and
  // looks like "the command worked and there are no peers" — which is exactly
  // what happened in an opencode session.
  it('rejects arguments it does not understand instead of starting the server', () => {
    expect(classifyArgv(['peers', 'list'])).toEqual({ kind: 'unknown', arg: 'peers' });
    expect(classifyArgv(['--peers'])).toEqual({ kind: 'unknown', arg: '--peers' });
    // `mcp` is a subcommand now, but only for install/uninstall/status: the
    // guessed `mcp peers list` is still refused, one level down.
    expect(classifyArgv(['mcp', 'peers', 'list']).kind).toBe('mcp');
    expect(parseMcpArgs(['peers', 'list']).ok).toBe(false);
  });

  // Documentation drift is silent: nothing fails when help describes a flag
  // that no longer exists, or omits one that does. Both directions are checked
  // because they fail differently — an invented flag sends a caller down a path
  // that errors, while an omitted one hides a capability that works.
  describe('help and argv parsing cannot drift apart', () => {
    /**
     * Flag tokens from the parts of help that make promises: the usage lines,
     * the bracketed continuation of the send synopsis, and the per-flag
     * descriptions under `send:`.
     *
     * Widened from "lines starting with `  tincan`" when `send` landed. That
     * filter alone would have skipped `--idempotency-key` and `--reply-via`,
     * which appear only on the continuation and description lines — so the two
     * checks below would have passed while silently covering three of five
     * flags, which is worse than not having them.
     */
    const documented = (): string[] =>
      helpText()
        .split('\n')
        .filter((line) => /^\s+(tincan\b|--|\[)/.test(line))
        .flatMap((line) => line.match(/(?<![\w-])--?[a-z][\w-]*/g) ?? []);

    /** Every flag any entry point accepts: the top-level ones plus send's and mcp's. */
    const accepted = (): string[] => [...FLAGS.flatMap((f) => f.flags), ...SEND_FLAGS, ...MCP_FLAGS, ...INBOX_FLAGS];

    it('documents every flag it accepts', () => {
      const docs = documented();
      for (const flag of accepted()) {
        expect(docs, `${flag} is accepted but undocumented`).toContain(flag);
      }
    });

    it('accepts every flag it documents', () => {
      for (const flag of documented()) {
        expect(accepted(), `help documents ${flag}, which is not accepted`).toContain(flag);
      }
    });

    it('covers send’s flags, not just the top-level ones', () => {
      // The check above passes vacuously if `documented()` stops matching the
      // send block, which is exactly how the first version of it went wrong.
      const docs = documented();
      for (const flag of SEND_FLAGS) {
        expect(docs, `${flag} must appear in help`).toContain(flag);
      }
      expect(docs).toContain('--idempotency-key');
      expect(docs).toContain('--reply-via');
    });

    it('documents every mcp action, on a usage line', () => {
      const usage = helpText()
        .split('\n')
        .filter((line) => /^\s+tincan mcp /.test(line));
      for (const action of MCP_ACTIONS) {
        expect(usage.some((l) => l.includes(`tincan mcp ${action}`)), `${action} missing`).toBe(true);
      }
      expect(documented()).toContain('--force');
    });
  });

  describe('the send subcommand', () => {
    it('is dispatched with its own arguments left unparsed', () => {
      const intent = classifyArgv(['send', '--to', 'muster-59', '--from', 'bd-1', '--message', 'x']);
      expect(intent.kind).toBe('send');
      if (intent.kind !== 'send') return;
      expect(intent.argv).toEqual(['--to', 'muster-59', '--from', 'bd-1', '--message', 'x']);
    });

    it('is one of three subcommands, and the others are still refused', () => {
      // The stance that produced this function has not been dropped: admitting
      // `send` and `mcp` must not admit the guessed CLI it was written to refuse.
      expect(classifyArgv(['peers'])).toEqual({ kind: 'unknown', arg: 'peers' });
      expect(classifyArgv(['message_log'])).toEqual({ kind: 'unknown', arg: 'message_log' });
      expect(SUBCOMMANDS).toEqual(['send', 'mcp', 'inbox']);
      expect(classifyArgv(['inbox','status'])).toEqual({kind:'inbox',argv:['status']});
    });

    it('dispatches mcp with its own arguments left unparsed', () => {
      expect(classifyArgv(['mcp', 'install', '--force'])).toEqual({
        kind: 'mcp',
        argv: ['install', '--force'],
      });
    });

    it('names the subcommand when refusing something that is not one', () => {
      // A caller that guessed `tincan peers` should be told what does exist,
      // not only what does not.
      expect(unknownArgText('peers')).toContain('send');
    });

    it('takes send as a subcommand only in first position', () => {
      // `--message "send"` must not be read as a subcommand, and a stray `send`
      // after a flag is a malformed line rather than a send.
      expect(classifyArgv(['--version', 'send']).kind).toBe('version');
      expect(classifyArgv(['nonsense', 'send'])).toEqual({ kind: 'unknown', arg: 'nonsense' });
    });
  });

  it('recognises the flags it does support, and bare invocation', () => {
    expect(classifyArgv([]).kind).toBe('serve');
    expect(classifyArgv(['--version']).kind).toBe('version');
    expect(classifyArgv(['-v']).kind).toBe('version');
    expect(classifyArgv(['--help']).kind).toBe('help');
    expect(classifyArgv(['-h']).kind).toBe('help');
  });
});
