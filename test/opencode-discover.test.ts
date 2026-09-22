import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { listOpencodeSessions } from '../src/opencode/discover.js';

const record = (over: Record<string, unknown> = {}) => ({
  session_id: 'ses_f41a2b3c4ffeExampleSess01Z',
  slug: 'nimble-wizard',
  title: 'auth refactor',
  directory: '/repo',
  state: 'idle',
  socket: '/tmp/nowhere/inst-a91f.sock',
  instance_id: 'inst-a91f',
  pid: 4242,
  plugin_version: '0.4.0',
  opencode_version: '1.18.31',
  updated_at: '2026-09-20T14:02:11Z',
  ...over,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-oc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, body: unknown) =>
  writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

describe('listOpencodeSessions', () => {
  it('returns nothing when the registry directory does not exist', async () => {
    const r = await listOpencodeSessions({ registryDir: join(dir, 'nope') });
    expect(r.peers).toEqual([]);
  });

  it(
    'tolerates a record that disappears between the directory read and the file read — ' +
      'the plugin deletes records on exit, so this is normal, not a fault (issue #11)',
    async () => {
      write('ses_real.json', record({ session_id: 'ses_real', slug: 'still-here' }));
      // A dangling symlink reproduces the race exactly rather than
      // approximately: readdir lists the name, and readFile then fails with
      // ENOENT — the same errno a file deleted in the gap produces. No mock,
      // no sleep, and nothing that a slower runner can change.
      symlinkSync(join(dir, 'ses_gone_target_that_does_not_exist'), join(dir, 'ses_gone.json'));

      const r = await listOpencodeSessions({ registryDir: dir, probe: async () => true });

      expect(r.peers.map((p) => p.rawName)).toEqual(['still-here']);
    },
  );

  it('tolerates an unreadable entry that is not a file at all', async () => {
    // Same `catch`, different errno (EISDIR). A refactor that narrowed the
    // tolerance to ENOENT alone would still be wrong: anything unreadable
    // here belongs to the plugin, not to us.
    write('ses_real.json', record({ session_id: 'ses_real', slug: 'still-here' }));
    mkdirSync(join(dir, 'ses_dir.json'));

    const r = await listOpencodeSessions({ registryDir: dir, probe: async () => true });

    expect(r.peers.map((p) => p.rawName)).toEqual(['still-here']);
  });

  it('drops unreachable marks for a registry directory that has since vanished', async () => {
    // #6. A refused probe marks the record in a process-wide in-memory Set,
    // so the peer is reported unreachable once and removed on the second
    // refusal. The sweep that forgets marks whose records are gone runs after
    // readdir — and the ENOENT path returns before it. A registry directory
    // deleted while marks are held therefore leaked them for the life of the
    // process, and the leak is not inert: a mark says "already reported", so
    // if the directory came back with the same record and a still-dead
    // socket, the peer would be pruned silently instead of being reported
    // unreachable the one time it is owed.
    const marks = new Set<string>();
    write('ses_f41a2b3c4ffeExampleSess01Z.json', record());

    const first = await listOpencodeSessions({
      registryDir: dir,
      probe: async () => false,
      unreachableMarks: marks,
    });
    expect(first.peers.map((p) => p.state)).toEqual(['unreachable']);
    expect(marks.size).toBe(1);

    rmSync(dir, { recursive: true, force: true });

    const second = await listOpencodeSessions({
      registryDir: dir,
      probe: async () => false,
      unreachableMarks: marks,
    });
    expect(second.peers).toEqual([]);
    expect(second.diagnostic).toContain('does not appear to be installed');
    expect([...marks]).toEqual([]);
  });

  it('leaves another directory\'s marks alone when ours vanishes', async () => {
    // The mark set is process-wide, so the ENOENT sweep must be scoped by
    // prefix exactly as the post-readdir one is. A second registry directory's
    // marks are none of this call's business.
    const marks = new Set<string>();
    const otherKey = join(tmpdir(), 'some-other-registry', 'ses_other.json');
    marks.add(otherKey);
    write('ses_f41a2b3c4ffeExampleSess01Z.json', record());

    await listOpencodeSessions({ registryDir: dir, probe: async () => false, unreachableMarks: marks });
    rmSync(dir, { recursive: true, force: true });
    await listOpencodeSessions({ registryDir: dir, probe: async () => false, unreachableMarks: marks });

    expect([...marks]).toEqual([otherKey]);
  });

  it('reads a session record', async () => {
    write('ses_f41a2b3c4ffeExampleSess01Z.json', record());
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      uuid: 'ses_f41a2b3c4ffeExampleSess01Z',
      rawName: 'nimble-wizard',
      cwd: '/repo',
      state: 'idle',
      socketPath: '/tmp/nowhere/inst-a91f.sock',
    });
  });

  it('names the peer from slug, never from title', async () => {
    write('ses_a.json', record({ session_id: 'ses_a', slug: 'proud-forest', title: 'a drifting title' }));
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers[0]!.rawName).toBe('proud-forest');
  });

  it('ignores the caller file and the socket — only ses_*.json are sessions', async () => {
    write('ses_a.json', record({ session_id: 'ses_a' }));
    write('inst-a91f.caller.json', { instance_id: 'inst-a91f', session_id: 'ses_a', pid: 1, tool: 't', at: 'x' });
    writeFileSync(join(dir, 'inst-a91f.sock'), '');
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers.map((p) => p.uuid)).toEqual(['ses_a']);
  });

  it('reports a refused session unreachable once, and prunes it only on a second confirming refusal', async () => {
    write('ses_dead.json', record({ session_id: 'ses_dead' }));

    const first = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(first.peers).toHaveLength(1);
    expect(first.peers[0]!.state).toBe('unreachable');
    // One refused 250ms probe is not proof of death, and the plugin only
    // rewrites a record on an event (SPEC §5) — so deleting here makes an
    // idle-but-slow instance invisible until someone types into it.
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(true);

    const second = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(second.peers).toEqual([]); // reported exactly once — change notice §2
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);

    const third = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(third.peers).toEqual([]);
  });

  it('a slow instance that answers the next probe keeps its record, and its mark is cleared', async () => {
    write('ses_slow.json', record({ session_id: 'ses_slow' }));

    expect(
      (await listOpencodeSessions({ registryDir: dir, probe: async () => false })).peers[0]!.state,
    ).toBe('unreachable');
    expect(
      (await listOpencodeSessions({ registryDir: dir, probe: async () => true })).peers[0]!.state,
    ).toBe('idle');
    expect(existsSync(join(dir, 'ses_slow.json'))).toBe(true);

    // The earlier mark is gone, so a genuine death later is still reported
    // once before it is pruned rather than being deleted on sight.
    const later = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(later.peers[0]!.state).toBe('unreachable');
    expect(existsSync(join(dir, 'ses_slow.json'))).toBe(true);
  });

  it('never deletes a file outside the registry, however the session_id is spelled', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'tc-oc-victim-'));
    const victim = join(outside, 'victim.json');
    writeFileSync(victim, JSON.stringify({ keep: true }));
    try {
      // The prune used to unlink `${registryDir}/${record.session_id}.json`,
      // with session_id read verbatim out of the file's own contents.
      const escape = relative(dir, join(outside, 'victim'));
      write('ses_evil.json', record({ session_id: escape }));
      await listOpencodeSessions({ registryDir: dir, probe: async () => false });
      await listOpencodeSessions({ registryDir: dir, probe: async () => false });
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a record whose session_id is not a ^ses_ id, exactly like a malformed one', async () => {
    // SPEC §7 already requires `^ses` on the wire, so this rejects nothing
    // legitimate.
    write('ses_evil.json', record({ session_id: '../../../victim' }));
    write('ses_ok2.json', record({ session_id: 'ses_ok2' }));
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers.map((p) => p.uuid)).toEqual(['ses_ok2']);
  });

  it('prunes by the directory entry name, not by the session_id inside the record', async () => {
    // If the plugin ever names a file anything but `<session_id>.json`, an
    // unlink derived from the contents silently misses and "report unreachable
    // once" becomes "report it forever".
    write('ses_filename.json', record({ session_id: 'ses_inside' }));
    write('ses_inside.json', 'not a record'); // decoy: must survive untouched
    await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(existsSync(join(dir, 'ses_filename.json'))).toBe(false);
    expect(existsSync(join(dir, 'ses_inside.json'))).toBe(true);
  });

  it('names the plugin when the registry directory does not exist', async () => {
    const r = await listOpencodeSessions({ registryDir: join(dir, 'nope') });
    expect(r.peers).toEqual([]);
    expect(r.diagnostic).toMatch(/plugin/i);
  });

  it('lists a record with no slug as an unnamed peer rather than dropping it', async () => {
    const { slug: _drop, ...noSlug } = record({ session_id: 'ses_nos' });
    write('ses_nos.json', noSlug);
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers).toHaveLength(1);
    expect(peers[0]!.rawName).toBeNull();
  });

  it('skips an unparseable record rather than throwing', async () => {
    write('ses_bad.json', 'not json');
    write('ses_ok.json', record({ session_id: 'ses_ok' }));
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers.map((p) => p.uuid)).toEqual(['ses_ok']);
  });

  it('skips a record with no session_id, which cannot be addressed at all', async () => {
    const { session_id: _drop, ...noId } = record();
    write('ses_noid.json', noId);
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => true });
    expect(peers).toEqual([]);
  });

  it('probes each distinct socket once, not once per session', async () => {
    write('ses_1.json', record({ session_id: 'ses_1' }));
    write('ses_2.json', record({ session_id: 'ses_2' }));
    let probes = 0;
    await listOpencodeSessions({ registryDir: dir, probe: async () => { probes += 1; return true; } });
    expect(probes).toBe(1);
  });
});
