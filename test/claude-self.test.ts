import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeSelf, registerSelf } from '../src/claude/self.js';
import { pointerDir, readPointers } from '../src/claude/registry.js';

let home: string;
const SID = '06a0f0b0-f629-4f1c-a8a5-b861432451a1';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tincan-self-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeSessionRecord(configDir: string, pid: number, sessionId: string) {
  const dir = join(configDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: '/src/thing', name: 'thing-a1', status: 'idle',
      procStart: 'Mon Sep 21 17:28:55 2026' }),
  );
}

describe('resolveClaudeSelf', () => {
  test('uses CLAUDE_CONFIG_DIR when set', () => {
    const cfg = join(home, '.claude-arm');
    writeSessionRecord(cfg, 62821, SID);
    const self = resolveClaudeSelf(
      { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: SID,
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/62821.sock' },
      62821,
      home,
    );
    expect(self?.configDir).toBe(cfg);
    expect(self?.registryDir).toBe(join(cfg, 'sessions'));
    expect(self?.pid).toBe(62821);
    expect(self?.procStart).toBe('Mon Sep 21 17:28:55 2026');
  });

  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    const self = resolveClaudeSelf(
      { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
      97213,
      home,
    );
    expect(self?.configDir).toBe(cfg);
  });

  test('takes the pid from the socket path, not from ppid, when they disagree', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    const self = resolveClaudeSelf(
      { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
      55555,
      home,
    );
    expect(self?.pid).toBe(97213);
  });

  test('falls back to ppid when the socket path names no pid', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    const self = resolveClaudeSelf(
      { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/weird.sock' },
      97213,
      home,
    );
    expect(self?.pid).toBe(97213);
  });

  test('refuses when the config dir holds no record for our session id', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, 'a-different-session');
    expect(
      resolveClaudeSelf(
        { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
        97213,
        home,
      ),
    ).toBeUndefined();
  });

  test('refuses when the config dir does not exist', () => {
    expect(
      resolveClaudeSelf(
        { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: join(home, 'nope'),
          CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
        97213,
        home,
      ),
    ).toBeUndefined();
  });

  test('refuses when CLAUDE_CODE_SESSION_ID is absent', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    expect(
      resolveClaudeSelf({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' }, 97213, home),
    ).toBeUndefined();
  });
});

describe('registerSelf', () => {
  test('writes a pointer naming our registry dir, and unregisters it', () => {
    const cfg = join(home, '.claude-arm');
    writeSessionRecord(cfg, 62821, SID);
    const env = { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/62821.sock', TINCAN_HOME: join(home, '.tincan') };

    const unregister = registerSelf(env, 62821, home);
    const dir = pointerDir(env, home);
    expect(readPointers(dir, () => true).map((r) => r.registryDir)).toEqual([join(cfg, 'sessions')]);

    unregister?.();
    expect(readPointers(dir, () => true)).toEqual([]);
  });

  test('writes no pointer, and returns undefined, when self cannot be resolved', () => {
    const env = { CLAUDE_CODE_SESSION_ID: SID, TINCAN_HOME: join(home, '.tincan') };
    expect(registerSelf(env, 97213, home)).toBeUndefined();
    expect(readPointers(pointerDir(env, home), () => true)).toEqual([]);
  });

  test('the pointer carries no name, cwd, status or token', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    const env = { CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock', TINCAN_HOME: join(home, '.tincan') };
    registerSelf(env, 97213, home);
    const [rec] = readPointers(pointerDir(env, home), () => true);
    expect(Object.keys(rec ?? {}).sort()).toEqual(
      ['configDir', 'pid', 'procStart', 'registryDir', 'sessionId', 'tincanVersion', 'writtenAt'],
    );
  });
});
