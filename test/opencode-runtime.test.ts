import { describe, test, expect } from 'vitest';
import { detectRuntime, limitsFor } from '../src/runtime.js';
import { CLAUDE_LIMITS, CODEX_LIMITS, OPENCODE_LIMITS } from '../src/guard.js';
import { methodFor } from '../src/tools.js';

describe('limitsFor', () => {
  test('opencode gets OPENCODE_LIMITS, not CLAUDE_LIMITS', () => {
    expect(limitsFor('opencode')).toBe(OPENCODE_LIMITS);
    expect(limitsFor('opencode')).not.toBe(CLAUDE_LIMITS);
  });
});

describe('detectRuntime', () => {
  test('is opencode when OPENCODE is set', () => {
    expect(detectRuntime({ OPENCODE: '1' })).toBe('opencode');
  });

  test('is opencode even when CLAUDE_CODE_MESSAGING_SOCKET is also inherited — the ' +
    'real case: an MCP subprocess inherits the environment of whatever launched ' +
    'opencode, and a stub MCP server run under opencode 1.18.31 was observed ' +
    'holding both variables at once', () => {
    expect(
      detectRuntime({ OPENCODE: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock' }),
    ).toBe('opencode');
  });

  test('is still claude-code when only the messaging socket is present', () => {
    expect(detectRuntime({ CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/x.sock' })).toBe('claude-code');
  });

  test('is still codex when neither is present', () => {
    expect(detectRuntime({})).toBe('codex');
  });
});

describe('methodFor', () => {
  test('opencode is opencode/prompt', () => {
    expect(methodFor('opencode')).toBe('opencode/prompt_async');
  });

  test('codex and claude-code are unchanged', () => {
    expect(methodFor('codex')).toBe('thread/queue/add');
    expect(methodFor('claude-code')).toBe('inbox');
  });
});
