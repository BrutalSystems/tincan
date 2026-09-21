import { describe, test, expect } from 'vitest';
import {
  parseConfigDirFromPsLine,
  parseConfigDirFromProcEnviron,
  resolveConfigDirFromProcess,
} from '../src/claude/env.js';

describe('parseConfigDirFromPsLine', () => {
  test('extracts the value from a ps -E command line', () => {
    const line =
      '/opt/claude --permission-mode auto HOME=/Users/x SHELL=/bin/zsh ' +
      'CLAUDE_CONFIG_DIR=/Users/x/.claude-arm TERM=xterm';
    expect(parseConfigDirFromPsLine(line)).toBe('/Users/x/.claude-arm');
  });

  test('handles a path containing spaces, by stopping at the next VAR=', () => {
    const line = 'claude HOME=/Users/x CLAUDE_CONFIG_DIR=/Users/x/My Configs/cc TERM=xterm';
    expect(parseConfigDirFromPsLine(line)).toBe('/Users/x/My Configs/cc');
  });

  test('handles the variable being last on the line', () => {
    const line = 'claude HOME=/Users/x CLAUDE_CONFIG_DIR=/Users/x/.claude-arm';
    expect(parseConfigDirFromPsLine(line)).toBe('/Users/x/.claude-arm');
  });

  test('is undefined when the variable is absent', () => {
    expect(parseConfigDirFromPsLine('claude HOME=/Users/x TERM=xterm')).toBeUndefined();
  });

  test('does not match a variable that merely ends with the name', () => {
    expect(parseConfigDirFromPsLine('claude MY_CLAUDE_CONFIG_DIR=/wrong')).toBeUndefined();
  });

  test('is undefined for an empty value rather than returning an empty path', () => {
    expect(parseConfigDirFromPsLine('claude CLAUDE_CONFIG_DIR= TERM=xterm')).toBeUndefined();
  });
});

describe('parseConfigDirFromProcEnviron', () => {
  test('reads a NUL-delimited environment', () => {
    const buf = ['HOME=/home/x', 'CLAUDE_CONFIG_DIR=/home/x/.claude-arm', 'TERM=xterm'].join('\0');
    expect(parseConfigDirFromProcEnviron(buf)).toBe('/home/x/.claude-arm');
  });

  test('is undefined when the variable is absent', () => {
    expect(parseConfigDirFromProcEnviron('HOME=/home/x\0TERM=xterm')).toBeUndefined();
  });

  test('does not match a variable that merely ends with the name', () => {
    expect(parseConfigDirFromProcEnviron('MY_CLAUDE_CONFIG_DIR=/wrong')).toBeUndefined();
  });
});

describe('resolveConfigDirFromProcess', () => {
  test('a live process with no override reports read:true and no configDir', () => {
    // The default config dir is expressed by the ABSENCE of the variable, so
    // "read it and found nothing" must be distinguishable from "could not
    // read it". Conflating the two made every default-dir session look
    // unidentifiable to a session running under a different config dir.
    const lookup = resolveConfigDirFromProcess(process.pid);
    expect(lookup.read).toBe(true);
    expect(lookup.configDir).toBeUndefined();
  });

  test('a pid that is not a process reports read:false', () => {
    expect(resolveConfigDirFromProcess(999999)).toEqual({ read: false });
  });
});
