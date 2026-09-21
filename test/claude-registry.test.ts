import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pointerDir,
  writePointer,
  removePointer,
  readPointers,
  type PointerRecord,
} from '../src/claude/registry.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tincan-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function rec(over: Partial<PointerRecord> = {}): PointerRecord {
  return {
    sessionId: '06a0f0b0-f629-4f1c-a8a5-b861432451a1',
    pid: 62821,
    configDir: '/Users/x/.claude-arm',
    registryDir: '/Users/x/.claude-arm/sessions',
    procStart: 'Mon Sep 21 17:28:55 2026',
    tincanVersion: '0.6.5',
    writtenAt: 1790011740004,
    ...over,
  };
}

describe('pointerDir', () => {
  test('defaults under the home dir', () => {
    expect(pointerDir({}, '/Users/x')).toBe('/Users/x/.tincan/peers/claude-code');
  });

  test('honours TINCAN_HOME', () => {
    expect(pointerDir({ TINCAN_HOME: '/srv/tc' }, '/Users/x')).toBe('/srv/tc/peers/claude-code');
  });

  test('ignores an empty TINCAN_HOME rather than rooting at /peers', () => {
    expect(pointerDir({ TINCAN_HOME: '' }, '/Users/x')).toBe('/Users/x/.tincan/peers/claude-code');
  });
});

describe('writePointer', () => {
  test('writes one file per session, named by session id', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    expect(existsSync(join(dir, '06a0f0b0-f629-4f1c-a8a5-b861432451a1.json'))).toBe(true);
  });

  test('creates the directory 0700 and the record 0600', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, '06a0f0b0-f629-4f1c-a8a5-b861432451a1.json')).mode & 0o777).toBe(0o600);
  });

  test('leaves no temp file behind', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    expect(readPointers(dir, () => true)).toHaveLength(1);
  });

  test('a session id with a path separator cannot escape the directory', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec({ sessionId: '../../escaped' }));
    expect(existsSync(join(home, 'escaped.json'))).toBe(false);
  });
});

describe('readPointers', () => {
  test('returns a written record', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    const got = readPointers(dir, () => true);
    expect(got).toHaveLength(1);
    expect(got[0]?.registryDir).toBe('/Users/x/.claude-arm/sessions');
  });

  test('is empty, not a throw, when the directory does not exist', () => {
    expect(readPointers(join(home, 'nope'), () => true)).toEqual([]);
  });

  test('prunes a record whose pid is dead', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec({ pid: 111 }));
    expect(readPointers(dir, (pid) => pid !== 111)).toEqual([]);
  });

  test('skips an unparseable record without losing the rest', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'garbage.json'), '{ not json');
    expect(readPointers(dir, () => true)).toHaveLength(1);
  });

  test('skips a record missing a required field', () => {
    const dir = pointerDir({}, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.json'), JSON.stringify({ sessionId: 'x', pid: 1 }));
    expect(readPointers(dir, () => true)).toEqual([]);
  });
});

describe('removePointer', () => {
  test('removes only the named session', () => {
    const dir = pointerDir({}, home);
    writePointer(dir, rec());
    writePointer(dir, rec({ sessionId: 'other', pid: 2 }));
    removePointer(dir, '06a0f0b0-f629-4f1c-a8a5-b861432451a1');
    const left = readPointers(dir, () => true);
    expect(left.map((r) => r.sessionId)).toEqual(['other']);
  });

  test('is silent when there is nothing to remove', () => {
    expect(() => removePointer(join(home, 'nope'), 'x')).not.toThrow();
  });
});
