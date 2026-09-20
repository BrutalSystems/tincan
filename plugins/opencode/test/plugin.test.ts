import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPlugin, type PluginDeps } from '../tincan-lib/plugin.js';
import type { Transport, TransportResponse } from '../tincan-lib/types.js';

const info = { id: 'ses_a', slug: 'nimble-wizard', title: 'auth refactor', directory: '/repo', version: '1.18.31' };
const healthy: TransportResponse = { response: { status: 200 }, data: { data: [], cursor: {} } };

let dir: string;
let logs: string[];
let tick: number;

/** An ADVANCING clock. With a frozen one, a redundant rewrite produces
 *  byte-identical output and the no-op test proves nothing. */
const clock = () => new Date(Date.UTC(2026, 8, 19, 14, 2, 11 + tick++));

function deps(over: Partial<PluginDeps> = {}): PluginDeps {
  return {
    dir,
    instanceId: 'inst-self',
    pid: 4242,
    transport: { get: vi.fn().mockResolvedValue(healthy), post: vi.fn() } as unknown as Transport,
    now: clock,
    sink: (l) => logs.push(l),
    ...over,
  };
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-plug-')); logs = []; tick = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('startPlugin — startup self-check', () => {
  it('binds the socket when GET /api/session is healthy', async () => {
    const d = deps();
    const hooks = await startPlugin(d);
    expect(d.transport.get).toHaveBeenCalledWith({ url: '/api/session' });
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(true);
    await hooks.dispose();
  });

  it('binds nothing and advertises nothing when the self-check returns HTML', async () => {
    const d = deps({ transport: { get: vi.fn().mockResolvedValue({ response: { status: 200 }, data: '<!doctype html>' }), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
    await hooks.event({ type: 'session.created', properties: { info } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('binds nothing when the transport throws', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
    await hooks.dispose();
  });
});

describe('startPlugin — registry lifecycle', () => {
  it('writes nothing on load, because a resumed session is never announced', async () => {
    const hooks = await startPlugin(deps());
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('writes a record on session.created', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const rec = JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8'));
    expect(rec.slug).toBe('nimble-wizard');
    expect(rec.state).toBe('idle');
    expect(rec.instance_id).toBe('inst-self');
    expect(rec.pid).toBe(4242);
    expect(rec.opencode_version).toBe('1.18.31');
    await hooks.dispose();
  });

  it('flips state to busy then back to idle', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.event({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('busy');
    await hooks.event({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('idle');
    await hooks.dispose();
  });

  it('ignores a state event for a session it never heard announced', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.status', properties: { sessionID: 'ses_unknown', status: { type: 'busy' } } });
    expect(existsSync(join(dir, 'ses_unknown.json'))).toBe(false);
    await hooks.dispose();
  });

  it('removes the record on session.deleted', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.event({ type: 'session.deleted', properties: { info } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('does not rewrite the file when nothing but the clock changed', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ type: 'session.updated', properties: { info } });
    // The clock advanced between the two events, so a rewrite WOULD change
    // updated_at. Identical bytes therefore prove the write was skipped.
    expect(readFileSync(join(dir, 'ses_a.json'), 'utf8')).toBe(first);
    await hooks.dispose();
  });

  it('rewrites the file when the title changes', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ type: 'session.updated', properties: { info: { ...info, title: 'PONG' } } });
    const after = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    expect(after).not.toBe(first);
    expect(JSON.parse(after).title).toBe('PONG');
    await hooks.dispose();
  });

  it('never throws out of the event hook on a malformed event', async () => {
    const hooks = await startPlugin(deps());
    await expect(hooks.event(null)).resolves.toBeUndefined();
    await expect(hooks.event({ type: 'session.created', properties: {} })).resolves.toBeUndefined();
    await hooks.dispose();
  });
});

describe('startPlugin — dispose', () => {
  it('removes this instance’s records and the socket', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ type: 'session.created', properties: { info } });
    await hooks.dispose();
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
  });

  it('is safe to call when startup never bound anything', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    await expect(hooks.dispose()).resolves.toBeUndefined();
  });
});
