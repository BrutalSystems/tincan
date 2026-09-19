import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime, selfNameFor, buildSide, codexSelfNameOf } from '../src/runtime.js';
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

describe('codexSelfNameOf', () => {
  test('slugifies the thread title, so `from=` matches what a peer must type to reply', () => {
    expect(codexSelfNameOf('Respond to greeting', '/src/x')).toBe('respond-to-greeting');
  });

  test('falls back to the directory name when the thread has no title', () => {
    expect(codexSelfNameOf(null, '/Users/mike/Source/brutalsystems')).toBe('brutalsystems');
  });
});

describe('buildSide', () => {
  test('hosted in Claude Code, it exposes Codex peers under the tighter Codex budget', () => {
    const side = buildSide('claude-code', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.selfRuntime).toBe('claude-code');
    expect(side.peerRuntime).toBe('codex');
    expect(side.limits).toBe(CODEX_LIMITS);
  });

  test('hosted in Codex, it exposes Claude Code peers under the Claude budget', () => {
    const side = buildSide('codex', { registryDir: join(dir, 'sessions'), pid: 1, cwd: '/src/x' });
    expect(side.peerRuntime).toBe('claude-code');
    expect(side.limits).toBe(CLAUDE_LIMITS);
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
