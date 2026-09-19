import { describe, test, expect } from 'vitest';
import { slugify, suffixOf, assignNames, resolvePeer, type PeerBase } from '../src/naming.js';

const p = (runtime: PeerBase['runtime'], rawName: string | null, uuid: string): PeerBase =>
  ({ runtime, rawName, uuid });

describe('slugify', () => {
  test('turns a Codex sentence title into a kebab slug', () => {
    expect(slugify('Review phase 1 handoff prompt')).toBe('review-phase-1-handoff-prompt');
  });

  test('collapses punctuation so "phase 1" and "phase-1" slug identically', () => {
    expect(slugify('Review phase-1 handoff prompt')).toBe(slugify('Review phase 1 handoff prompt'));
  });
});

describe('suffixOf', () => {
  test('is the last three hex characters of the uuid', () => {
    expect(suffixOf('00000000-0000-0000-0000-0000000007f3')).toBe('7f3');
  });

  test('distinguishes Codex thread ids, which are UUIDv7 and share a leading timestamp', () => {
    const a = '01a0b94d-cf5f-7f12-be5f-819a7cde963a';
    const b = '01a07110-2a80-7430-b44c-ef62464bb601';
    expect(a.slice(0, 3)).toBe(b.slice(0, 3));
    expect(suffixOf(a)).not.toBe(suffixOf(b));
  });
});

describe('assignNames', () => {
  test('displays a bare slug when nothing collides', () => {
    const [a] = assignNames([p('codex', 'Auth refactor', '00000000-0000-0000-0000-0000000007f3')]);
    expect(a!.display).toBe('auth-refactor');
  });

  test('builds the canonical id as runtime:slug.suffix regardless of collision', () => {
    const [a] = assignNames([p('codex', 'Auth refactor', '00000000-0000-0000-0000-0000000007f3')]);
    expect(a!.canonicalId).toBe('codex:auth-refactor.7f3');
  });

  test('suffixes every colliding peer and only those', () => {
    const peers = assignNames([
      p('codex', 'Review phase 1 handoff prompt', '00000000-0000-0000-0000-000000000aaa'),
      p('codex', 'Review phase-1 handoff prompt', '00000000-0000-0000-0000-000000000bbb'),
      p('codex', 'Something else', '00000000-0000-0000-0000-000000000ccc'),
    ]);
    expect(peers.map((x) => x.display)).toEqual([
      'review-phase-1-handoff-prompt.aaa',
      'review-phase-1-handoff-prompt.bbb',
      'something-else',
    ]);
  });

  test('displays an unnamed thread as thread.<suffix>', () => {
    const [a] = assignNames([p('codex', null, '00000000-0000-0000-0000-0000000007f3')]);
    expect(a!.display).toBe('thread.7f3');
  });
});

describe('resolvePeer', () => {
  const peers = assignNames([
    p('codex', 'Auth refactor', '00000000-0000-0000-0000-0000000007f3'),
    p('codex', 'Billing sync', '00000000-0000-0000-0000-000000000b12'),
    p('codex', 'Billing report', '00000000-0000-0000-0000-000000000b34'),
  ]);

  test('resolves an exact display name', () => {
    const r = resolvePeer(peers, 'auth-refactor');
    expect(r.ok && r.peer.canonicalId).toBe('codex:auth-refactor.7f3');
  });

  test('resolves case-insensitively', () => {
    const r = resolvePeer(peers, 'Auth-Refactor');
    expect(r.ok).toBe(true);
  });

  test('resolves an unambiguous prefix', () => {
    const r = resolvePeer(peers, 'auth');
    expect(r.ok && r.peer.display).toBe('auth-refactor');
  });

  test('accepts the fully qualified form even with no collision', () => {
    const r = resolvePeer(peers, 'auth-refactor.7f3');
    expect(r.ok).toBe(true);
  });

  test('refuses an ambiguous prefix and lists every candidate suffixed', () => {
    const r = resolvePeer(peers, 'billing');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.candidates.sort()).toEqual(['billing-report.b34', 'billing-sync.b12']);
    }
  });

  test('refuses an unknown peer', () => {
    const r = resolvePeer(peers, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown');
  });
});
