import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepUnaccounted } from '../src/claude/sweep.js';

let runtimeDir: string;
let sockDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'tincan-run-'));
  sockDir = join(runtimeDir, 'cc-socks');
  mkdirSync(sockDir, { recursive: true });
});
afterEach(() => rmSync(runtimeDir, { recursive: true, force: true }));

/** A plain file is enough: the sweep reads names, the probe is discovery's job. */
function socket(pid: number) {
  writeFileSync(join(sockDir, `${pid}.sock`), '');
}

const env = () => ({ XDG_RUNTIME_DIR: runtimeDir });

describe('sweepUnaccounted', () => {
  test('finds a live socket no registry accounted for', () => {
    socket(111);
    socket(222);
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set([111]),
      resolveConfigDir: () => '/Users/x/.claude-arm',
      isLive: () => true,
    });
    expect(result.resolvedDirs).toEqual(['/Users/x/.claude-arm/sessions']);
    expect(result.unresolved).toEqual([]);
  });

  test('never calls the resolver when every socket is accounted for', () => {
    socket(111);
    let calls = 0;
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set([111]),
      resolveConfigDir: () => {
        calls += 1;
        return undefined;
      },
      isLive: () => true,
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ resolvedDirs: [], unresolved: [] });
  });

  test('reports an unresolvable pid instead of hiding it', () => {
    socket(333);
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set(),
      resolveConfigDir: () => undefined,
      isLive: () => true,
    });
    expect(result.resolvedDirs).toEqual([]);
    expect(result.unresolved).toEqual([{ pid: 333, socketPath: join(sockDir, '333.sock') }]);
  });

  test('ignores a socket whose process is dead', () => {
    socket(444);
    let calls = 0;
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set(),
      resolveConfigDir: () => {
        calls += 1;
        return '/x';
      },
      isLive: () => false,
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ resolvedDirs: [], unresolved: [] });
  });

  test('two unaccounted pids in one config dir yield one dir', () => {
    socket(555);
    socket(666);
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set(),
      resolveConfigDir: () => '/Users/x/.claude-arm',
      isLive: () => true,
    });
    expect(result.resolvedDirs).toEqual(['/Users/x/.claude-arm/sessions']);
  });

  test('ignores files that are not <pid>.sock', () => {
    writeFileSync(join(sockDir, 'README'), '');
    writeFileSync(join(sockDir, 'notapid.sock'), '');
    const result = sweepUnaccounted({
      env: env(),
      uid: 501,
      socketDirs: [sockDir],
      accountedPids: new Set(),
      resolveConfigDir: () => '/x',
      isLive: () => true,
    });
    expect(result).toEqual({ resolvedDirs: [], unresolved: [] });
  });

  test('is empty, not a throw, when no socket dir exists', () => {
    const result = sweepUnaccounted({
      env: { XDG_RUNTIME_DIR: join(runtimeDir, 'nope') },
      uid: 501,
      socketDirs: [join(runtimeDir, 'nope', 'cc-socks')],
      accountedPids: new Set(),
      resolveConfigDir: () => '/x',
      isLive: () => true,
    });
    expect(result).toEqual({ resolvedDirs: [], unresolved: [] });
  });
});
