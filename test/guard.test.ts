import { describe, test, expect } from 'vitest';
import { Guard, CLAUDE_LIMITS, CODEX_LIMITS } from '../src/guard.js';

const PEER = 'codex:auth-refactor.7f3';

/** A guard with a clock we control, so window expiry is tested without waiting. */
function guardAt(limits = CLAUDE_LIMITS) {
  let now = 1_000_000;
  const g = new Guard(limits, () => now);
  return { g, advance: (ms: number) => (now += ms) };
}

describe('size', () => {
  test('refuses a message over 100_000 characters', () => {
    const { g } = guardAt();
    const v = g.check(PEER, 'x'.repeat(100_001));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('too_large');
  });

  test('allows a message exactly at the cap', () => {
    const { g } = guardAt();
    expect(g.check(PEER, 'x'.repeat(100_000)).ok).toBe(true);
  });
});

describe('identical repeat', () => {
  test('refuses the same text to the same peer inside the window', () => {
    const { g } = guardAt();
    g.record(PEER, 'ping');
    const v = g.check(PEER, 'ping');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('identical_repeat');
  });

  test('allows the same text once the window has passed', () => {
    const { g, advance } = guardAt();
    g.record(PEER, 'ping');
    advance(60_001);
    expect(g.check(PEER, 'ping').ok).toBe(true);
  });

  test('allows the same text to a different peer', () => {
    const { g } = guardAt();
    g.record(PEER, 'ping');
    expect(g.check('codex:other.abc', 'ping').ok).toBe(true);
  });
});

describe('rate limit', () => {
  test('refuses the 11th Claude message inside a minute', () => {
    const { g } = guardAt(CLAUDE_LIMITS);
    for (let i = 0; i < 10; i++) g.record(PEER, `m${i}`);
    const v = g.check(PEER, 'm10');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('rate_limited');
  });

  test('recovers once the minute has rolled off', () => {
    const { g, advance } = guardAt(CLAUDE_LIMITS);
    for (let i = 0; i < 10; i++) g.record(PEER, `m${i}`);
    advance(60_001);
    expect(g.check(PEER, 'm10').ok).toBe(true);
  });

  test('holds Codex to a tighter budget than Claude, because each send starts a turn', () => {
    expect(CODEX_LIMITS.perMinute).toBeLessThan(CLAUDE_LIMITS.perMinute);
    const { g } = guardAt(CODEX_LIMITS);
    for (let i = 0; i < CODEX_LIMITS.perMinute; i++) g.record(PEER, `m${i}`);
    expect(g.check(PEER, 'next').ok).toBe(false);
  });
});

describe('runaway backstop', () => {
  test('refuses once the per-peer ceiling is reached even with the minute rate respected', () => {
    const { g, advance } = guardAt(CLAUDE_LIMITS);
    for (let i = 0; i < CLAUDE_LIMITS.maxQueued; i++) {
      g.record(PEER, `m${i}`);
      advance(61_000 / CLAUDE_LIMITS.perMinute);
    }
    const v = g.check(PEER, 'one-more');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('queue_full');
  });
});

describe('refusal text', () => {
  test('tells the sender not to resend immediately', () => {
    const { g } = guardAt();
    g.record(PEER, 'ping');
    const v = g.check(PEER, 'ping');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail.toLowerCase()).toContain('do not resend');
  });
});
