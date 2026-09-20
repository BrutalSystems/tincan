import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfSessionId, parseOpencodePid } from '../src/opencode/self.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-oc-self-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const writeCaller = (instanceId: string, over: Record<string, unknown> = {}) =>
  writeFileSync(
    join(dir, `${instanceId}.caller.json`),
    JSON.stringify({
      instance_id: instanceId,
      session_id: 'ses_self',
      pid: 41233,
      tool: 'tincan_send_peer',
      at: '2026-09-19T14:02:11Z',
      ...over,
    }),
  );

describe('selfSessionId', () => {
  it('matches the caller file whose pid equals OPENCODE_PID', async () => {
    writeCaller('inst-a91f');
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
    expect(id).toBe('ses_self');
  });

  it(
    'fails on the naive string/number comparison — env.OPENCODE_PID is a string, the ' +
      "caller file's pid is a number, so `rec.pid === env.OPENCODE_PID` is always false",
    async () => {
      writeCaller('inst-a91f', { pid: 41233 });
      const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
      expect(id).toBe('ses_self');
      // Sanity-check the trap itself, so this test cannot pass for the wrong reason.
      expect(41233 === ('41233' as unknown)).toBe(false);
    },
  );

  it('is undefined when OPENCODE_PID is absent', async () => {
    writeCaller('inst-a91f');
    const id = await selfSessionId({ registryDir: dir, env: {} });
    expect(id).toBeUndefined();
  });

  it('is undefined when OPENCODE_PID is not an integer', async () => {
    writeCaller('inst-a91f');
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: 'not-a-pid' } });
    expect(id).toBeUndefined();
  });

  it(
    'is undefined when OPENCODE_PID is an empty string — Number(\'\') is 0 and ' +
      'Number.isInteger(0) is true, so a naive integer check alone would treat an empty ' +
      'env var as a valid pid of 0',
    async () => {
      writeCaller('inst-a91f', { pid: 0 });
      const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '' } });
      expect(id).toBeUndefined();
    },
  );

  it('is undefined when OPENCODE_PID is whitespace only', async () => {
    writeCaller('inst-a91f', { pid: 0 });
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '   ' } });
    expect(id).toBeUndefined();
  });

  it('is undefined when the registry directory does not exist', async () => {
    const id = await selfSessionId({
      registryDir: join(dir, 'nope'),
      env: { OPENCODE_PID: '41233' },
    });
    expect(id).toBeUndefined();
  });

  it('is undefined when no caller file matches our pid', async () => {
    writeCaller('inst-a91f', { pid: 999 });
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
    expect(id).toBeUndefined();
  });

  it('ignores session records and sockets, matching only inst-*.caller.json', async () => {
    writeFileSync(
      join(dir, 'ses_other.json'),
      JSON.stringify({ session_id: 'ses_other', pid: 41233 }),
    );
    writeFileSync(join(dir, 'inst-a91f.sock'), '');
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
    expect(id).toBeUndefined();
  });

  it('skips an unparseable caller file rather than throwing', async () => {
    writeFileSync(join(dir, 'inst-bad.caller.json'), '{ not json');
    writeCaller('inst-a91f');
    const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
    expect(id).toBe('ses_self');
  });
});

describe('parseOpencodePid', () => {
  it('parses a real pid', () => {
    expect(parseOpencodePid({ OPENCODE_PID: '41233' })).toBe(41233);
  });

  it('rejects an empty string, which Number() would otherwise coerce to a valid-looking 0', () => {
    expect(parseOpencodePid({ OPENCODE_PID: '' })).toBeUndefined();
  });

  it('rejects whitespace only', () => {
    expect(parseOpencodePid({ OPENCODE_PID: '   ' })).toBeUndefined();
  });

  it('rejects a literal pid of 0 too — no real process has pid 0', () => {
    expect(parseOpencodePid({ OPENCODE_PID: '0' })).toBeUndefined();
  });

  it('rejects a non-numeric value', () => {
    expect(parseOpencodePid({ OPENCODE_PID: 'not-a-pid' })).toBeUndefined();
  });

  it('rejects a missing value', () => {
    expect(parseOpencodePid({})).toBeUndefined();
  });

  it('rejects a negative value', () => {
    expect(parseOpencodePid({ OPENCODE_PID: '-1' })).toBeUndefined();
  });
});
