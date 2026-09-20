import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeRecord, sameIgnoringTimestamp, writeRecord, removeRecord, removeAllForInstance, sweepOrphans, type RecordContext } from '../tincan-lib/registry.js';
import type { SessionInfo } from '../tincan-lib/types.js';

const info: SessionInfo = {
  id: 'ses_f4185535affe0nxzk66nw19ihJ',
  slug: 'nimble-wizard',
  title: 'auth refactor',
  directory: '/Users/mike/Source/billing',
  version: '1.18.31',
};

const ctx: RecordContext = {
  socket: '/Users/mike/.tincan/peers/opencode/inst-a91f.sock',
  instance_id: 'inst-a91f',
  pid: 41233,
  plugin_version: '1.0.0',
  now: () => new Date('2026-09-19T14:02:11.000Z'),
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tincan-reg-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('composeRecord', () => {
  it('builds the documented shape', () => {
    expect(composeRecord(info, 'idle', ctx)).toEqual({
      session_id: 'ses_f4185535affe0nxzk66nw19ihJ',
      slug: 'nimble-wizard',
      title: 'auth refactor',
      directory: '/Users/mike/Source/billing',
      state: 'idle',
      socket: '/Users/mike/.tincan/peers/opencode/inst-a91f.sock',
      instance_id: 'inst-a91f',
      pid: 41233,
      plugin_version: '1.0.0',
      opencode_version: '1.18.31',
      updated_at: '2026-09-19T14:02:11Z',
    });
  });

  it('takes opencode_version from the session info, not a constant', () => {
    const rec = composeRecord({ ...info, version: '1.19.0' }, 'busy', ctx);
    expect(rec.opencode_version).toBe('1.19.0');
  });
});

describe('sameIgnoringTimestamp', () => {
  it('is true when only updated_at differs', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord(info, 'idle', { ...ctx, now: () => new Date('2027-01-01T00:00:00Z') });
    expect(sameIgnoringTimestamp(a, b)).toBe(true);
  });

  it('is false when the title changes', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord({ ...info, title: 'PONG' }, 'idle', ctx);
    expect(sameIgnoringTimestamp(a, b)).toBe(false);
  });

  it('is false when the state changes', () => {
    const a = composeRecord(info, 'idle', ctx);
    const b = composeRecord(info, 'busy', ctx);
    expect(sameIgnoringTimestamp(a, b)).toBe(false);
  });
});

describe('writeRecord', () => {
  it('writes readable JSON named by session id', async () => {
    const rec = composeRecord(info, 'idle', ctx);
    await writeRecord(dir, rec);
    const onDisk = JSON.parse(readFileSync(join(dir, `${info.id}.json`), 'utf8'));
    expect(onDisk).toEqual(rec);
  });

  it('leaves no temp files behind', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    expect(readdirSync(dir)).toEqual([`${info.id}.json`]);
  });

  it('forces the parent directory to 0700 even when it already exists at 0755', async () => {
    chmodSync(dir, 0o755);
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('overwrites an existing record', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await writeRecord(dir, composeRecord(info, 'busy', ctx));
    const onDisk = JSON.parse(readFileSync(join(dir, `${info.id}.json`), 'utf8'));
    expect(onDisk.state).toBe('busy');
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe('removeRecord', () => {
  it('deletes the file', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await removeRecord(dir, info.id);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is silent when the file is already gone', async () => {
    await expect(removeRecord(dir, 'ses_missing')).resolves.toBeUndefined();
  });
});

describe('removeAllForInstance', () => {
  it('deletes only records carrying the given instance id', async () => {
    await writeRecord(dir, composeRecord(info, 'idle', ctx));
    await writeRecord(dir, composeRecord({ ...info, id: 'ses_other' }, 'idle', { ...ctx, instance_id: 'inst-zzzz' }));
    await removeAllForInstance(dir, 'inst-a91f');
    expect(readdirSync(dir)).toEqual(['ses_other.json']);
  });

  it('ignores unparseable files rather than throwing', async () => {
    writeFileSync(join(dir, 'ses_junk.json'), 'not json');
    await expect(removeAllForInstance(dir, 'inst-a91f')).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual(['ses_junk.json']);
  });
});

describe('sweepOrphans', () => {
  const recFor = (sessionID: string, instance: string) => composeRecord(
    { ...info, id: sessionID },
    'idle',
    { ...ctx, instance_id: instance, socket: join(dir, `${instance}.sock`) },
  );

  it('removes the files and socket of an instance whose socket is refused', async () => {
    await writeRecord(dir, recFor('ses_dead', 'inst-dead'));
    writeFileSync(join(dir, 'inst-dead.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-dead']);
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-dead.sock'))).toBe(false);
  });

  it('sweeps a dead socket that has no registry files at all', async () => {
    // The --continue-then-kill-9 case: bound a socket, never advertised.
    writeFileSync(join(dir, 'inst-silent.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-silent']);
    expect(existsSync(join(dir, 'inst-silent.sock'))).toBe(false);
  });

  it('leaves a live sibling instance completely alone', async () => {
    await writeRecord(dir, recFor('ses_live', 'inst-live'));
    writeFileSync(join(dir, 'inst-live.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => true);
    expect(swept).toEqual([]);
    expect(existsSync(join(dir, 'ses_live.json'))).toBe(true);
    expect(existsSync(join(dir, 'inst-live.sock'))).toBe(true);
  });

  it('never sweeps our own instance, even when the probe says dead', async () => {
    await writeRecord(dir, recFor('ses_mine', 'inst-self'));
    writeFileSync(join(dir, 'inst-self.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual([]);
    expect(existsSync(join(dir, 'ses_mine.json'))).toBe(true);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(true);
  });

  it('removes an orphan record whose socket file is already gone', async () => {
    await writeRecord(dir, recFor('ses_dead', 'inst-gone'));
    const swept = await sweepOrphans(dir, 'inst-self', async () => false);
    expect(swept).toEqual(['inst-gone']);
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);
  });

  it('returns an empty list for an empty or missing directory', async () => {
    await expect(sweepOrphans(dir, 'inst-self', async () => false)).resolves.toEqual([]);
    await expect(sweepOrphans(join(dir, 'nope'), 'inst-self', async () => false)).resolves.toEqual([]);
  });

  it('ignores unparseable files rather than throwing', async () => {
    writeFileSync(join(dir, 'ses_junk.json'), 'not json');
    await expect(sweepOrphans(dir, 'inst-self', async () => false)).resolves.toEqual([]);
    expect(existsSync(join(dir, 'ses_junk.json'))).toBe(true);
  });

  it('probes each distinct instance only once', async () => {
    await writeRecord(dir, recFor('ses_1', 'inst-dead'));
    await writeRecord(dir, recFor('ses_2', 'inst-dead'));
    writeFileSync(join(dir, 'inst-dead.sock'), '');
    let probes = 0;
    await sweepOrphans(dir, 'inst-self', async () => { probes += 1; return false; });
    expect(probes).toBe(1);
  });

  it('treats a throwing probe as dead', async () => {
    writeFileSync(join(dir, 'inst-boom.sock'), '');
    const swept = await sweepOrphans(dir, 'inst-self', async () => { throw new Error('probe blew up'); });
    expect(swept).toEqual(['inst-boom']);
  });
});
