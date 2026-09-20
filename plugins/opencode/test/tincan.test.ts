import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from 'node:fs';
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
