import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
