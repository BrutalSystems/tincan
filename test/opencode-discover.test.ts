import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('reports a refused session as unreachable, and prunes its record', async () => {
    write('ses_dead.json', record({ session_id: 'ses_dead' }));
    const { peers } = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(peers).toHaveLength(1);
    expect(peers[0]!.state).toBe('unreachable');
    // Reported once, then gone — change notice §2.
    expect(existsSync(join(dir, 'ses_dead.json'))).toBe(false);
    const again = await listOpencodeSessions({ registryDir: dir, probe: async () => false });
    expect(again.peers).toEqual([]);
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
