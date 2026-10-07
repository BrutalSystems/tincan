import { describe, test, expect, vi } from 'vitest';
import { withOpencodeHost, describeProcess, type ProcessInfo } from '../src/opencode/host.js';
import { detectRuntime } from '../src/runtime.js';

/** A process tree to walk: pid → { ppid, command }. */
function tree(nodes: Record<number, ProcessInfo>) {
  return vi.fn(async (pid: number) => nodes[pid]);
}

describe('withOpencodeHost', () => {
  test('leaves a 1.x environment alone — opencode 1.x sets both variables itself', async () => {
    const describe = tree({});
    const env = { OPENCODE: '1', OPENCODE_PID: '4242' };
    expect(await withOpencodeHost(env, 100, describe)).toBe(env);
    expect(describe).not.toHaveBeenCalled();
  });

  // opencode 2.x sets neither for an MCP server it starts [verified 2.0.24],
  // so without this the server detects `codex` — or `claude-code`, when the
  // background service inherited a Claude Code terminal's environment — and
  // every message it sends names the wrong sender.
  test('supplies OPENCODE and OPENCODE_PID when the parent is opencode', async () => {
    const describe = tree({ 500: { ppid: 1, command: '/opt/oc/bin/opencode' } });
    const env = await withOpencodeHost({ PATH: '/bin' }, 500, describe);
    expect(env).toEqual({ PATH: '/bin', OPENCODE: '1', OPENCODE_PID: '500' });
  });

  test('looks past a launcher — `npx tincan` puts npm and node between us and opencode', async () => {
    const describe = tree({
      300: { ppid: 400, command: 'node' },
      400: { ppid: 500, command: '/usr/local/bin/npm' },
      500: { ppid: 1, command: 'opencode' },
    });
    expect((await withOpencodeHost({}, 300, describe)).OPENCODE_PID).toBe('500');
  });

  test('stops at a nearer Claude Code or Codex — a claude started in an opencode terminal is Claude Code', async () => {
    for (const harness of ['claude', '/usr/local/bin/codex']) {
      const describe = tree({
        300: { ppid: 400, command: harness },
        400: { ppid: 1, command: 'opencode' },
      });
      const env = { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock' };
      expect(await withOpencodeHost(env, 300, describe)).toBe(env);
    }
  });

  test('gives up quietly when the tree cannot be read or holds no opencode', async () => {
    expect(await withOpencodeHost({}, 300, tree({}))).toEqual({});
    expect(await withOpencodeHost({}, 300, tree({ 300: { ppid: 1, command: 'zsh' } }))).toEqual({});
    const throws = vi.fn(async () => { throw new Error('no ps'); });
    expect(await withOpencodeHost({}, 300, throws)).toEqual({});
  });

  test('does not walk forever on a cycle or a deep tree', async () => {
    const describe = tree({ 300: { ppid: 300, command: 'sh' } });
    await withOpencodeHost({}, 300, describe);
    expect(describe.mock.calls.length).toBeLessThanOrEqual(8);
  });

  test('turns the leaked-Claude-environment case into opencode', async () => {
    const describe = tree({ 500: { ppid: 1, command: 'opencode' } });
    const leaked = { CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock' };
    expect(detectRuntime(await withOpencodeHost(leaked, 500, describe))).toBe('opencode');
  });
});

describe('describeProcess', () => {
  test('reads a real process — this one', async () => {
    const me = await describeProcess(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.command).toMatch(/node/);
  });

  test('answers undefined for a pid that does not exist', async () => {
    expect(await describeProcess(2 ** 22 + 7)).toBeUndefined();
  });
});
