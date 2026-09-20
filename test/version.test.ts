import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION, versionLine, helpText, classifyArgv } from '../src/version.js';

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
    expect(classifyArgv(['mcp', 'peers', 'list'])).toEqual({ kind: 'unknown', arg: 'mcp' });
    expect(classifyArgv(['--peers'])).toEqual({ kind: 'unknown', arg: '--peers' });
  });

  it('recognises the flags it does support, and bare invocation', () => {
    expect(classifyArgv([]).kind).toBe('serve');
    expect(classifyArgv(['--version']).kind).toBe('version');
    expect(classifyArgv(['-v']).kind).toBe('version');
    expect(classifyArgv(['--help']).kind).toBe('help');
    expect(classifyArgv(['-h']).kind).toBe('help');
  });
});
