import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime, selfNameFor, buildSide, codexSelfNameOf, makeSelfNameResolver } from '../src/runtime.js';
import { CLAUDE_LIMITS, CODEX_LIMITS } from '../src/guard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-rt-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('detectRuntime', () => {
  test('is claude-code when the messaging socket is in the environment', () => {
    expect(detectRuntime({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock' })).toBe(
      'claude-code',
    );
  });

  test('assumes codex otherwise', () => {
    expect(detectRuntime({})).toBe('codex');
  });
});

describe('selfNameFor', () => {
  test('uses the hosting Claude session name from the registry', () => {
    writeFileSync(
      join(dir, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, name: 'billing-api', cwd: '/src/billing' }),
    );
    expect(selfNameFor('claude-code', { registryDir: join(dir, 'sessions'), pid: 4242, cwd: '/src/billing' })).toBe(
      'billing-api',
    );
  });

  test('finds the hosting session by CLAUDE_CODE_SESSION_ID, since the MCP server is a child process', () => {
    writeFileSync(
      join(dir, 'sessions', '4242.json'),
      JSON.stringify({
        pid: 4242,
        sessionId: '5af69d42-2214-41d9-b13f-9c3177eb60ce',
        name: 'billing-api',
        cwd: '/src/billing',
      }),
    );
    const name = selfNameFor('claude-code', {
      registryDir: join(dir, 'sessions'),
      pid: 99999,
      cwd: '/src/billing',
      env: { CLAUDE_CODE_SESSION_ID: '5af69d42-2214-41d9-b13f-9c3177eb60ce' },
    });
    expect(name).toBe('billing-api');
  });

  test('falls back to the working directory name when no registry entry exists', () => {
    expect(selfNameFor('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/auth-service' })).toBe(
      'auth-service',
    );
  });
});

describe('self-name resolution timing', () => {
  test('a directory fallback is not cached, so a later lookup can still find the real name', async () => {
    // A Codex thread has no title until its first turn, but the MCP server
    // starts before that and resolves selfName for its startup diagnostic.
    // Caching that fallback left the session calling itself by its directory
    // for the rest of its life.
    let titled = false;
    const resolve = async () => (titled ? 'respond-to-greeting' : undefined);
    const cached = makeSelfNameResolver(resolve, '/Users/mike/Source/brutalsystems/tincan');

    expect(await cached()).toBe('tincan'); // before the first turn
    titled = true;
    expect(await cached()).toBe('respond-to-greeting'); // after it
  });

  test('a real name is cached, so the protocol call happens once', async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      return 'auth-refactor';
    };
    const cached = makeSelfNameResolver(resolve, '/src/x');
    await cached();
    await cached();
    expect(calls).toBe(1);
  });
});

describe('codexSelfNameOf', () => {
  test('slugifies the thread title, so `from=` matches what a peer must type to reply', () => {
    expect(codexSelfNameOf('Respond to greeting', '/src/x')).toBe('respond-to-greeting');
  });

  test('falls back to the directory name when the thread has no title', () => {
    expect(codexSelfNameOf(null, '/Users/mike/Source/brutalsystems')).toBe('brutalsystems');
  });
});

describe('buildSide', () => {
  test('hosted in Claude Code, it exposes Codex peers only', () => {
    // Claude Code reaches its own sessions natively via SendMessage.
    const side = buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.selfRuntime).toBe('claude-code');
    expect(side.peerRuntimes).toEqual(['codex']);
  });

  test('hosted in Codex, it exposes both runtimes', () => {
    // Codex's collaboration tools only reach its own spawn tree, so it has no
    // native path to either an independent Codex session or a Claude one.
    const side = buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.peerRuntimes).toEqual(['codex', 'claude-code']);
  });

  test('budgets are per peer runtime, so Codex stays tighter in a mixed listing', () => {
    const side = buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.limitsFor('codex')).toBe(CODEX_LIMITS);
    expect(side.limitsFor('claude-code')).toBe(CLAUDE_LIMITS);
  });

  test('resolves its own name lazily, since the Codex side must derive it at runtime', async () => {
    const side = buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/auth-service' });
    expect(typeof side.selfName).toBe('function');
    expect(await side.selfName()).toBe('auth-service');
  });

  test('reports urgent as unsupported on both sides, because neither peer can be steered', () => {
    for (const r of ['claude-code', 'codex'] as const) {
      expect(buildSide(r, { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' }).supportsUrgent).toBe(false);
    }
  });
});
