import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  /**
   * opencode instantiates a plugin more than once per process (four bound
   * instance sockets under a single pid on opencode 1.18.31 — issue #19), and
   * every instance stamps its caller file with the SAME process.pid. So
   * several `inst-*.caller.json` can match OPENCODE_PID at once, each naming
   * whichever session last called a Tin Can tool *on that instance*. Only the
   * most recent one is us.
   *
   * readdir order is unspecified, so each of these runs both arrangements:
   * selection by directory position gets exactly one of the two wrong, whichever
   * name the filesystem happens to yield first.
   */
  const arrangements = [
    { newest: 'inst-aaaa', older: 'inst-zzzz' },
    { newest: 'inst-zzzz', older: 'inst-aaaa' },
  ];

  for (const { newest, older } of arrangements) {
    it(`prefers the newest caller file when several share our pid (${newest} newest)`, async () => {
      writeCaller(older, { session_id: 'ses_earlier', at: '2026-09-19T14:02:11Z' });
      writeCaller(newest, { session_id: 'ses_latest', at: '2026-09-19T14:09:44Z' });
      const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
      expect(id).toBe('ses_latest');
    });

    it(`breaks an identical whole-second \`at\` by mtime (${newest} newest)`, async () => {
      // isoStamp is whole seconds (SPEC §4), so two sessions calling a Tin Can
      // tool inside the same second carry byte-identical `at` values and the
      // file's own mtime is the only remaining signal.
      writeCaller(older, { session_id: 'ses_earlier' });
      writeCaller(newest, { session_id: 'ses_latest' });
      utimesSync(join(dir, `${older}.caller.json`), new Date(1_000), new Date(1_000));
      utimesSync(join(dir, `${newest}.caller.json`), new Date(2_000), new Date(2_000));
      const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
      expect(id).toBe('ses_latest');
    });

    it(`ranks a caller file with an unusable \`at\` below any dated one (${newest} dated)`, async () => {
      writeCaller(older, { session_id: 'ses_undated', at: 'not-a-timestamp' });
      writeCaller(newest, { session_id: 'ses_latest', at: '2026-09-19T14:02:11Z' });
      const id = await selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' } });
      expect(id).toBe('ses_latest');
    });
  }

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

// #3. The caller file is per-instance, so a sibling session on the same
// instance can overwrite it between Tin Can writing and reading. Per-call
// tickets replace "most recent wins" with "our own call is in flight by
// definition, so one fresh ticket can only be ours".
describe('selfSessionId — per-call tickets', () => {
  const NOW = Date.parse('2026-09-22T12:00:00Z');
  const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

  const writeTicket = (
    instanceId: string,
    callId: string,
    over: Record<string, unknown> = {},
  ) =>
    writeFileSync(
      join(dir, `${instanceId}.${callId}.call.json`),
      JSON.stringify({
        instance_id: instanceId,
        session_id: 'ses_self',
        pid: 41233,
        tool: 'tincan_send_peer',
        call_id: callId,
        at: at(0),
        ...over,
      }),
    );

  const resolve = () =>
    selfSessionId({ registryDir: dir, env: { OPENCODE_PID: '41233' }, now: () => NOW });

  it('resolves the session named by the only fresh ticket', async () => {
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_me' });
    expect(await resolve()).toBe('ses_me');
  });

  it('beats a caller file a sibling overwrote — the race this exists to close', async () => {
    // Our call is in flight, so our ticket is on disk. Meanwhile a sibling
    // session on the same instance called a Tin Can tool and clobbered the
    // shared caller file with its own id. Recency says the sibling; the
    // ticket says us, and the ticket is right.
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_me' });
    writeCaller('inst-a91f', { session_id: 'ses_sibling', at: '2026-09-22T12:00:00Z' });
    expect(await resolve()).toBe('ses_me');
  });

  it('refuses to guess when two sessions have calls in flight', async () => {
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_me' });
    writeTicket('inst-a91f', 'c2', { session_id: 'ses_sibling' });
    // undefined means "exclude the whole instance" to the caller, which
    // over-excludes a sibling rather than risking a self-send.
    expect(await resolve()).toBeUndefined();
  });

  it('is not confused by one session holding several calls at once', async () => {
    // Nested or concurrent Tin Can calls from the SAME session are not
    // ambiguity — there is still only one answer.
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_me' });
    writeTicket('inst-a91f', 'c2', { session_id: 'ses_me' });
    expect(await resolve()).toBe('ses_me');
  });

  it('expires a ticket a crashed call left behind, and falls back', async () => {
    // opencode skips tool.execute.after on an error, a denied permission or
    // an abort, so leaked tickets are expected rather than exceptional.
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_ghost', at: at(3600) });
    writeCaller('inst-a91f', { session_id: 'ses_self' });
    expect(await resolve()).toBe('ses_self');
  });

  it('does not let a stale ticket manufacture ambiguity', async () => {
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_me' });
    writeTicket('inst-a91f', 'c2', { session_id: 'ses_ghost', at: at(3600) });
    expect(await resolve()).toBe('ses_me');
  });

  it('ignores a ticket whose timestamp cannot be read', async () => {
    // Unaged is untrustworthy: counting it fresh would let one bad record
    // block self-resolution permanently.
    writeTicket('inst-a91f', 'c1', { session_id: 'ses_junk', at: 'not-a-date' });
    writeCaller('inst-a91f', { session_id: 'ses_self' });
    expect(await resolve()).toBe('ses_self');
  });

  it('ignores a ticket belonging to another opencode process', async () => {
    writeTicket('inst-other', 'c1', { session_id: 'ses_elsewhere', pid: 999 });
    writeCaller('inst-a91f', { session_id: 'ses_self' });
    expect(await resolve()).toBe('ses_self');
  });

  it('falls back to the caller file when the plugin writes no tickets at all', async () => {
    // An older plugin against a current core. The plugin installs separately,
    // so this skew is normal and must keep working exactly as before.
    writeCaller('inst-a91f', { session_id: 'ses_self' });
    expect(await resolve()).toBe('ses_self');
  });
});
