import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetName, pruneNames, recallName, rememberName } from '../tincan-lib/names.js';

let dir: string;
const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 7);

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-names-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('session names, remembered across restarts', () => {
  it('recalls a remembered name', async () => {
    await rememberName(dir, 'ses_abc123', 'swift-eagle', t0);
    expect(await recallName(dir, 'ses_abc123')).toBe('swift-eagle');
  });

  it('keeps names out of the registry listing — the core reads only ses_*.json', async () => {
    await rememberName(dir, 'ses_abc123', 'swift-eagle', t0);
    expect(readdirSync(dir).filter((f) => f.startsWith('ses_'))).toEqual([]);
  });

  it('is owner-only, like every other file under the registry', async () => {
    await rememberName(dir, 'ses_abc123', 'swift-eagle', t0);
    const [file] = readdirSync(join(dir, 'names'));
    expect(statSync(join(dir, 'names', file as string)).mode & 0o777).toBe(0o600);
  });

  it('answers undefined for a session it never saw', async () => {
    expect(await recallName(dir, 'ses_never')).toBeUndefined();
  });

  it('forgets a deleted session', async () => {
    await rememberName(dir, 'ses_abc123', 'swift-eagle', t0);
    await forgetName(dir, 'ses_abc123');
    expect(await recallName(dir, 'ses_abc123')).toBeUndefined();
  });

  it.each(['../evil', 'ses_../../x', 'msg_abc', '', 'ses_a/b'])(
    'refuses %j as a session id — it becomes a file name',
    async (id) => {
      await rememberName(dir, id, 'x', t0);
      expect(await recallName(dir, id)).toBeUndefined();
      expect(existsSync(join(dir, 'names')) ? readdirSync(join(dir, 'names')) : []).toEqual([]);
    },
  );

  it('prunes names not seen for 30 days, and keeps newer ones', async () => {
    await rememberName(dir, 'ses_old', 'old-one', t0 - 31 * DAY);
    await rememberName(dir, 'ses_new', 'new-one', t0 - 2 * DAY);
    await pruneNames(dir, t0);
    expect(await recallName(dir, 'ses_old')).toBeUndefined();
    expect(await recallName(dir, 'ses_new')).toBe('new-one');
  });

  it('prunes nothing, and does not throw, when there is no names directory yet', async () => {
    await expect(pruneNames(dir, t0)).resolves.toBeUndefined();
  });
});
