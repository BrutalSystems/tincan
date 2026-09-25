/**
 * End-to-end against the built binary, because the unit tests did not catch
 * what actually shipped broken.
 *
 * 1.9.0 registered once at startup. 1.9.1 also repaired on a `peers` call.
 * Both left the real case unfixed: Claude Code assigns the session's true id
 * moments AFTER spawning the MCP server, so the startup write records the boot
 * id, and a session that never calls a tool never repairs it — while every
 * peer is told it cannot reply, and arriving envelopes tell the session itself
 * that it has no send_peer to answer with.
 *
 * So this test spawns `dist/tincan.js` exactly as a harness would, moves the
 * session id underneath it with no tool call at all, and waits for the pointer
 * on disk to follow. Nothing here is mocked except the clock's patience.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const BOOT = '11111111-1111-4111-8111-111111111111';
const NOW = '22222222-2222-4222-8222-222222222222';
const HARNESS_PID = 424242;

let home: string;
let child: ChildProcess | undefined;

const pointerDir = () => join(home, '.tincan', 'peers', 'claude-code');
const sessionsDir = () => join(home, '.claude', 'sessions');

function writeSessionRecord(sessionId: string, name: string): void {
  writeFileSync(
    join(sessionsDir(), `${HARNESS_PID}.json`),
    JSON.stringify({ pid: HARNESS_PID, sessionId, name, cwd: '/src/probe', status: 'idle' }),
  );
}

function pointers(): Array<{ sessionId: string; tincanVersion: string }> {
  try {
    return readdirSync(pointerDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(pointerDir(), f), 'utf8')) as {
        sessionId: string;
        tincanVersion: string;
      });
  } catch {
    return [];
  }
}

/** Polls rather than sleeping a fixed span: fast when it works, honest when it does not. */
async function until<T>(what: string, f: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tincan-e2e-'));
  mkdirSync(sessionsDir(), { recursive: true });
});
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('the built server keeps its registration true on its own', () => {
  test('follows the session id the harness assigns after it was spawned', async () => {
    // What the harness has published at the moment we are spawned.
    writeSessionRecord(BOOT, 'probe-a1');

    child = spawn(process.execPath, [join(process.cwd(), 'dist', 'tincan.js')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        TINCAN_HOME: join(home, '.tincan'),
        CLAUDE_CODE_MESSAGING_SOCKET: `/tmp/cc-socks/${HARNESS_PID}.sock`,
        CLAUDE_CODE_SESSION_ID: BOOT,
        TINCAN_SELF_REFRESH_MS: '300',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await until('the startup registration', () =>
      pointers().some((p) => p.sessionId === BOOT) ? true : undefined,
    );

    // Claude Code reassigns the id. No tool is called; nothing tells Tin Can.
    writeSessionRecord(NOW, 'probe-a1');

    await until('the registration to follow the new id', () =>
      pointers().some((p) => p.sessionId === NOW) ? true : undefined,
    );

    // And the orphan is gone: two pointers at one live pid would make one
    // Tin Can look like two sessions, one of them reporting a stale version.
    const ids = pointers().map((p) => p.sessionId);
    expect(ids).toEqual([NOW]);
  }, 20000);
});
