import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TinCan } from '../tincan.js';

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
