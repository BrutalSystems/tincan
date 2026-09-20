import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfSessionId } from '../src/opencode/self.js';

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
