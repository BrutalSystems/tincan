import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TinCan } from '../tincan.js';
import type { PluginHooks } from '../tincan-lib/plugin.js';

// The sink's chmod is the only thing here that cannot be made to fail by
// arranging the filesystem — a file we just appended to is a file we can
// chmod. One fault, injected and then spent, is the whole mock.
const fsFaults = vi.hoisted(() => ({ chmodFailures: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (path: Parameters<typeof actual.chmodSync>[0], mode: Parameters<typeof actual.chmodSync>[1]) => {
      if (fsFaults.chmodFailures > 0) {
        fsFaults.chmodFailures--;
        throw new Error('EPERM: simulated chmod failure');
      }
      return actual.chmodSync(path, mode);
    },
  };
});

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-entry-'));
  prevHome = process.env.TINCAN_HOME;
  process.env.TINCAN_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.TINCAN_HOME;
  else process.env.TINCAN_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

// Every other artefact here is owner-only (peers dir 0700, socket 0600,
// records 0600). The log holds no message bodies, but it does hold session
// ids, peer names, message ids and delivery modes — a record of who is
// messaging whom — so it must not be left world-readable.
describe('TinCan plugin log file permissions', () => {
  it('creates the log file at 0600', async () => {
    await TinCan({ client: {} });
    const logPath = join(dir, 'opencode-plugin.log');
    expect(existsSync(logPath)).toBe(true);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of a pre-existing world-readable log file', async () => {
    const logPath = join(dir, 'opencode-plugin.log');
    writeFileSync(logPath, '', { mode: 0o644 });
    chmodSync(logPath, 0o644);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);

    await TinCan({ client: {} });

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
});

describe('TinCan plugin log rotation', () => {
  it('rotates a log that has grown past the cap and keeps one generation', async () => {
    // The log used to grow for the life of the install, with the README
    // telling the reader to truncate it by hand.
    const logPath = join(dir, 'opencode-plugin.log');
    writeFileSync(logPath, 'x'.repeat(5 * 1024 * 1024));

    await TinCan({ client: {} });

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(statSync(`${logPath}.1`).size).toBe(5 * 1024 * 1024);
    // The rotated file is re-secured too — it can inherit a pre-existing
    // world-readable mode from before the live file was ever tightened.
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
    // The live log restarted, holding only what this load wrote.
    expect(statSync(logPath).size).toBeLessThan(1024);
    expect(readFileSync(logPath, 'utf8')).toContain('[tincan]');
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('leaves a log below the cap in place', async () => {
    const logPath = join(dir, 'opencode-plugin.log');
    writeFileSync(logPath, 'earlier line\n');

    await TinCan({ client: {} });

    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toContain('earlier line');
  });
});

describe('TinCan plugin log sink — a chmod that throws', () => {
  it('retries the chmod on the next line rather than recording a tightening that did not happen', async () => {
    const logPath = join(dir, 'opencode-plugin.log');
    writeFileSync(logPath, '', { mode: 0o644 });
    chmodSync(logPath, 0o644);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);

    // Fail the first chmod of the load, and only that one.
    fsFaults.chmodFailures = 1;

    const healthy = { response: { status: 200 }, data: { data: [], cursor: {} } };
    const transport = { get: vi.fn().mockResolvedValue(healthy), post: vi.fn() };
    const hooks = await TinCan({ client: { _client: transport } }) as PluginHooks;

    // The load wrote its `bound` line and the chmod behind it threw, so the
    // log is still world-readable. The fault is spent.
    expect(fsFaults.chmodFailures).toBe(0);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);

    // A second line, through the same sink and the same closure. Were the
    // flag set on the assumption that the chmod succeeded, the sink would
    // now believe this file was already 0600 and never chmod it again —
    // leaving it at 0644 for the life of the session.
    await hooks.event({ event: { get type(): string { throw new Error('boom'); } } });

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    await hooks.dispose();
  });
});
