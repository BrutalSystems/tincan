import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveClaudeSelf,
  registerSelf,
  syncSelfPointer,
  startSelfPointerRefresh,
} from '../src/claude/self.js';
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

  /**
   * This used to refuse, and refusing is what took 13 of 25 live sessions off
   * the air. A record at our own pid naming a different session is not a
   * mismatch to fail closed on — it is Claude Code having reassigned our id
   * while we ran, which is routine. The record is the harness's current
   * statement about the process; our environment is a snapshot of when we were
   * spawned. The record wins.
   */
  test('takes the id from the record at our pid even when our environment disagrees', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, 'a-different-session');
    expect(
      resolveClaudeSelf(
        { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
        97213,
        home,
      )?.sessionId,
    ).toBe('a-different-session');
  });

  test('refuses when the config dir holds no record for our pid at all', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 55555, SID);
    expect(
      resolveClaudeSelf(
        { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
        97213,
        home,
      ),
    ).toBeUndefined();
  });

  test('refuses when the record at our pid names no session', () => {
    const cfg = join(home, '.claude');
    mkdirSync(join(cfg, 'sessions'), { recursive: true });
    writeFileSync(join(cfg, 'sessions', '97213.json'), JSON.stringify({ pid: 97213, name: 'x' }));
    expect(
      resolveClaudeSelf(
        { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' },
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

  /**
   * Also inverted, and for the better. The variable used to be the only way to
   * name ourselves, so its absence meant we could not, and the arm fell back
   * to hiding our whole config dir. Reading our own pid's record names us
   * without it — which is the difference between excluding ourselves precisely
   * and excluding an entire account to be safe.
   */
  test('resolves without CLAUDE_CODE_SESSION_ID, from the record at our pid', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 97213, SID);
    expect(
      resolveClaudeSelf({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/97213.sock' }, 97213, home)
        ?.sessionId,
    ).toBe(SID);
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

/**
 * Claude Code reassigns a session's id while the harness process lives — it
 * rewrites `<pid>.json` with a new `sessionId` on resume — and an MCP server
 * spawned earlier keeps the OLD id in its environment forever. Verified on
 * this machine: MCP pid 50431 held
 * CLAUDE_CODE_SESSION_ID=dd754ea0-… while its harness pid 50400 was
 * registered as 9aeb9b26-…, and 13 of 25 live sessions were in that state.
 *
 * Keying identity on the environment variable therefore keys it on a
 * transient boot id. The record at our own pid is the only statement that
 * stays true, because the pid is what cannot drift inside a live process.
 */
describe('when Claude Code reassigns the session id under a live process', () => {
  const BOOT = '073ad916-d46a-4018-b19a-0c36b088d9da';
  const NOW = '5c379b7c-c023-47fd-ae85-9b2222ec6c55';
  const envFor = (cfg: string, pid: number, sessionId: string) => ({
    CLAUDE_CONFIG_DIR: cfg,
    CLAUDE_CODE_SESSION_ID: sessionId,
    CLAUDE_CODE_MESSAGING_SOCKET: `/tmp/cc-socks/${pid}.sock`,
    TINCAN_HOME: join(home, '.tincan'),
  });

  test('resolves the id the harness records at our pid, not the one in our environment', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, NOW);
    const self = resolveClaudeSelf(envFor(cfg, 18233, BOOT), 18233, home);
    expect(self?.sessionId).toBe(NOW);
  });

  test('registers the pointer under the current id, so peers can see we can reply', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, NOW);
    const env = envFor(cfg, 18233, BOOT);
    registerSelf(env, 18233, home);
    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([NOW]);
  });

  /**
   * The orphan must GO, not merely be joined by a correct record. Two
   * pointers at one live pid make one Tin Can look like two sessions, and the
   * stale one carries the version that was running when it was written.
   */
  test('a drift after startup leaves exactly one pointer, under the new id', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, BOOT);
    const env = envFor(cfg, 18233, BOOT);
    registerSelf(env, 18233, home);
    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([BOOT]);

    // The harness reassigns the id; our environment still says BOOT.
    writeSessionRecord(cfg, 18233, NOW);
    syncSelfPointer(env, 18233, home);

    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([NOW]);
  });

  test('syncing is idempotent: no drift, no rewrite, still one pointer', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, NOW);
    const env = envFor(cfg, 18233, NOW);
    registerSelf(env, 18233, home);
    syncSelfPointer(env, 18233, home);
    syncSelfPointer(env, 18233, home);
    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([NOW]);
  });

  test('leaves another session\'s pointer at a different pid alone', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, NOW);
    writeSessionRecord(cfg, 999, 'someone-else');
    const env = envFor(cfg, 18233, BOOT);
    registerSelf(envFor(cfg, 999, 'someone-else'), 999, home);
    syncSelfPointer(env, 18233, home);
    expect(
      readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId).sort(),
    ).toEqual([NOW, 'someone-else']);
  });
});

/**
 * 1.9.1 repaired the pointer on every `peers` call, which is not enough — and
 * the shortfall is a trap rather than a gap.
 *
 * Measured after 1.9.1 shipped: 20 of 25 live MCP servers held an env id that
 * disagreed with the harness record at their own ppid, including sessions
 * started minutes earlier. The reassignment is not an occasional resume
 * artifact; it is the ordinary startup sequence — the MCP server is spawned
 * with a boot id and the harness assigns the session's real id just after. So
 * `registerSelf` at startup writes the wrong key almost every time.
 *
 * The trap: a drifted session is advertised to senders as unable to reply, so
 * the envelope tells the RECIPIENT "no send_peer to answer with". A session
 * that believes that never calls a Tin Can tool, so the repair that only runs
 * on a tool call never runs. Observed live: a session told exactly that, which
 * then reported to its user that it could not acknowledge a message it had
 * plainly received.
 *
 * The refresh therefore cannot depend on the model doing anything.
 */
describe('keeping the pointer true without being asked', () => {
  const BOOT = '073ad916-d46a-4018-b19a-0c36b088d9da';
  const NOW = '5c379b7c-c023-47fd-ae85-9b2222ec6c55';

  function fakeClock() {
    const ticks: Array<() => void> = [];
    return {
      schedule: (fn: () => void) => {
        ticks.push(fn);
        return () => {};
      },
      tick: () => ticks.forEach((f) => f()),
    };
  }

  test('registers immediately, then repairs the id the harness assigns after startup', () => {
    const cfg = join(home, '.claude');
    // Startup: the harness record still carries the boot id our env was given.
    writeSessionRecord(cfg, 18233, BOOT);
    const env = {
      CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_CODE_SESSION_ID: BOOT,
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/18233.sock',
      TINCAN_HOME: join(home, '.tincan'),
    };
    const clock = fakeClock();
    const stop = startSelfPointerRefresh(env, 18233, { home, schedule: clock.schedule });
    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([BOOT]);

    // Seconds later the harness assigns the real id. Nobody calls a tool.
    writeSessionRecord(cfg, 18233, NOW);
    clock.tick();

    expect(readPointers(pointerDir(env, home), () => true).map((r) => r.sessionId)).toEqual([NOW]);
    stop();
  });

  test('stopping removes the pointer under whichever id is current', () => {
    const cfg = join(home, '.claude');
    writeSessionRecord(cfg, 18233, BOOT);
    const env = {
      CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/18233.sock',
      TINCAN_HOME: join(home, '.tincan'),
    };
    const clock = fakeClock();
    const stop = startSelfPointerRefresh(env, 18233, { home, schedule: clock.schedule });
    writeSessionRecord(cfg, 18233, NOW);
    clock.tick();
    stop();
    expect(readPointers(pointerDir(env, home), () => true)).toEqual([]);
  });
});
