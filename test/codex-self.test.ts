import { describe, test, expect } from 'vitest';
import { pickSelfThreadId } from '../src/codex/self.js';

const holders = new Map<string, number>([
  ['01a0b99a-9bbe-79f0-b64d-ee041f357a42', 22035],
  ['01a0b94d-cf5f-7f12-be5f-819a7cde963a', 83547],
]);

describe('pickSelfThreadId', () => {
  test('finds the thread whose writer lock our host process holds', () => {
    expect(pickSelfThreadId(holders, [22035])).toBe('01a0b99a-9bbe-79f0-b64d-ee041f357a42');
  });

  test('walks up the process chain, since the MCP server may not be a direct child', () => {
    expect(pickSelfThreadId(holders, [99999, 4242, 83547])).toBe(
      '01a0b94d-cf5f-7f12-be5f-819a7cde963a',
    );
  });

  test('prefers the nearest ancestor when more than one holds a lock', () => {
    expect(pickSelfThreadId(holders, [22035, 83547])).toBe('01a0b99a-9bbe-79f0-b64d-ee041f357a42');
  });

  test('is undefined when no ancestor holds a lock', () => {
    expect(pickSelfThreadId(holders, [1, 2, 3])).toBeUndefined();
  });

  test('is undefined when nothing holds any lock', () => {
    expect(pickSelfThreadId(new Map(), [22035])).toBeUndefined();
  });

  test('accepts our own pid at the head of the chain, for hosts that run us in-process', () => {
    expect(pickSelfThreadId(holders, [22035, 400, 300])).toBe(
      '01a0b99a-9bbe-79f0-b64d-ee041f357a42',
    );
  });
});

import { ancestorPids } from '../src/codex/self.js';

describe('ancestorPids', () => {
  const tree = new Map<number, number>([
    [500, 400],
    [400, 300],
    [300, 1],
  ]);
  const parentOf = async (pid: number) => tree.get(pid);

  test('lists ancestors nearest first, starting from the immediate parent', async () => {
    expect(await ancestorPids(500, parentOf)).toEqual([400, 300, 1]);
  });

  test('stops at the process tree root', async () => {
    expect(await ancestorPids(300, parentOf)).toEqual([1]);
  });

  test('stops when a parent cannot be read', async () => {
    expect(await ancestorPids(999, parentOf)).toEqual([]);
  });

  test('does not loop forever if the tree reports a cycle', async () => {
    const cyclic = async (pid: number) => (pid === 10 ? 20 : 10);
    const got = await ancestorPids(10, cyclic);
    expect(got.length).toBeLessThan(10);
  });
});
