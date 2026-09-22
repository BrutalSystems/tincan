import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
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
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    const rec = JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8'));
    expect(rec.slug).toBe('nimble-wizard');
    expect(rec.state).toBe('idle');
    expect(rec.instance_id).toBe('inst-self');
    expect(rec.pid).toBe(4242);
    expect(rec.opencode_version).toBe('1.18.31');
    await hooks.dispose();
  });

  it('tolerates a bare event too, not just opencode\'s real wrapped { event } shape', async () => {
    // opencode's actual contract is `event: (input: { event: Event }) => ...`,
    // but a future opencode version changing that wrapper must not silently
    // switch the plugin off again — see the normalisation comment in
    // startPlugin's event hook. Cast past PluginHooks' declared (accurate)
    // type to exercise the runtime tolerance deliberately.
    const hooks = await startPlugin(deps());
    const bare = { type: 'session.created', properties: { info } };
    await (hooks.event as unknown as (i: unknown) => Promise<void>)(bare);
    const rec = JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8'));
    expect(rec.slug).toBe('nimble-wizard');
    await hooks.dispose();
  });

  it('flips state to busy then back to idle', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('busy');
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_a' } } });
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).state).toBe('idle');
    await hooks.dispose();
  });

  it('ignores a state event for a session it never heard announced', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_unknown', status: { type: 'busy' } } } });
    expect(existsSync(join(dir, 'ses_unknown.json'))).toBe(false);
    await hooks.dispose();
  });

  it('removes the record on session.deleted', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    await hooks.event({ event: { type: 'session.deleted', properties: { info } } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('removes the record on session.deleted even when the payload omits version', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(true);
    const { version: _drop, ...noVersion } = info;
    await hooks.event({ event: { type: 'session.deleted', properties: { info: noVersion } } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('does not rewrite the file when nothing but the clock changed', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ event: { type: 'session.updated', properties: { info } } });
    // The clock advanced between the two events, so a rewrite WOULD change
    // updated_at. Identical bytes therefore prove the write was skipped.
    expect(readFileSync(join(dir, 'ses_a.json'), 'utf8')).toBe(first);
    await hooks.dispose();
  });

  it('rewrites the file when the title changes', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    const first = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    await hooks.event({ event: { type: 'session.updated', properties: { info: { ...info, title: 'PONG' } } } });
    const after = readFileSync(join(dir, 'ses_a.json'), 'utf8');
    expect(after).not.toBe(first);
    expect(JSON.parse(after).title).toBe('PONG');
    await hooks.dispose();
  });

  it('never throws out of the event hook on a malformed event', async () => {
    const hooks = await startPlugin(deps());
    await expect((hooks.event as unknown as (i: unknown) => Promise<void>)(null)).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: 'session.created', properties: {} } })).resolves.toBeUndefined();
    await hooks.dispose();
  });
});

describe('startPlugin — serialised registry mutation', () => {
  it('leaves no file behind when a status event and a delete overlap', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    // Deliberately NOT awaited in turn: opencode dispatches events without
    // waiting for the previous one to settle. Unserialised, the status
    // event's write lands after the delete's unlink and the file survives
    // with state:"busy" — and because `known` no longer holds it, nothing
    // ever rewrites or removes it again.
    const status = hooks.event({ event: { type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } } });
    const deleted = hooks.event({ event: { type: 'session.deleted', properties: { info } } });
    await Promise.all([status, deleted]);
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    await hooks.dispose();
  });

  it('does not skip the next identical event after a failed write', async () => {
    const hooks = await startPlugin(deps());
    // A directory at the record's path makes the atomic rename fail. Nothing
    // is mocked: this is the real write path failing the way a full disk or
    // a permissions change would.
    mkdirSync(join(dir, 'ses_a.json'));
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    expect(logs.join('\n')).toContain('event=event.failed');

    rmSync(join(dir, 'ses_a.json'), { recursive: true, force: true });
    // The identical event must be retried, not deduped against a memory
    // entry for a write that never landed.
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    expect(statSync(join(dir, 'ses_a.json')).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'ses_a.json'), 'utf8')).slug).toBe('nimble-wizard');
    await hooks.dispose();
  });
});

describe('startPlugin — dispose', () => {
  it('removes this instance’s records and the socket', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    await hooks.dispose();
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
  });

  it('is safe to call when startup never bound anything', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    await expect(hooks.dispose()).resolves.toBeUndefined();
  });

  it('is safe to call twice', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    await hooks.dispose();
    await expect(hooks.dispose()).resolves.toBeUndefined();
  });

  it('writes nothing for an event that arrives after dispose', async () => {
    const hooks = await startPlugin(deps());
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    await hooks.dispose();
    // A closed ServerHandle is still a truthy object; the event hook must
    // still no-op once dispose has run, or a late fire-and-forget dispatch
    // could resurrect a deleted registry file pointing at a dead socket.
    await hooks.event({ event: { type: 'session.created', properties: { info } } });
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
  });
});

describe('startPlugin — caller identity', () => {
  it('records the session that invoked a Tin Can tool', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_send_peer', sessionID: 'ses_caller', callID: 'c1' });
    const rec = JSON.parse(readFileSync(join(dir, 'inst-self.caller.json'), 'utf8'));
    expect(rec.session_id).toBe('ses_caller');
    expect(rec.instance_id).toBe('inst-self');
    expect(rec.pid).toBe(4242);
    await hooks.dispose();
  });

  it('ignores tools that are not Tin Can’s', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_other', callID: 'c1' });
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
    await hooks.dispose();
  });

  it('writes nothing when startup never bound anything', async () => {
    const d = deps({ transport: { get: vi.fn().mockRejectedValue(new Error('gone')), post: vi.fn() } as unknown as Transport });
    const hooks = await startPlugin(d);
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' });
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
    await hooks.dispose();
  });

  it('never throws on a malformed hook input', async () => {
    const hooks = await startPlugin(deps());
    await expect(hooks['tool.execute.before'](null)).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before']({})).resolves.toBeUndefined();
    await hooks.dispose();
  });

  // #3. The caller file is scoped to the instance, so a sibling session on
  // the same instance can overwrite it between Tin Can writing and reading
  // it. Per-call tickets let the reader identify the caller with certainty
  // instead of by recency: our own call is in flight by definition.
  it('writes a per-call ticket alongside the caller file', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_send_peer', sessionID: 'ses_caller', callID: 'c1' });

    const ticket = JSON.parse(readFileSync(join(dir, 'inst-self.c1.call.json'), 'utf8'));
    expect(ticket).toMatchObject({ session_id: 'ses_caller', instance_id: 'inst-self', pid: 4242, call_id: 'c1' });
    // The caller file is still written: an older core reads only that, and
    // the plugin installs separately from the core.
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(true);
    await hooks.dispose();
  });

  it('removes the ticket when the call ends, and leaves the caller file alone', async () => {
    const hooks = await startPlugin(deps());
    const call = { tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' };
    await hooks['tool.execute.before'](call);
    await hooks['tool.execute.after'](call);

    expect(existsSync(join(dir, 'inst-self.c1.call.json'))).toBe(false);
    // Not cleared: it is the older core's only signal, and is overwritten
    // rather than emptied by design.
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(true);
    await hooks.dispose();
  });

  it('leaves concurrent tickets standing when only one call ends', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_a', callID: 'c1' });
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_b', callID: 'c2' });
    await hooks['tool.execute.after']({ tool: 'tincan_peers', sessionID: 'ses_a', callID: 'c1' });

    expect(existsSync(join(dir, 'inst-self.c1.call.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-self.c2.call.json'))).toBe(true);
    await hooks.dispose();
  });

  it('writes no ticket when the host supplies no callID', async () => {
    // An opencode old enough not to pass one still gets the caller file, and
    // the reader falls back to it.
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller' });

    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.call.json'))).toEqual([]);
    await hooks.dispose();
  });

  it('cannot be made to write outside the registry directory by a hostile callID', async () => {
    // callID is an opaque host string and this turns it into a path segment.
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({
      tool: 'tincan_peers',
      sessionID: 'ses_caller',
      callID: '../../escaped',
    });

    const written = readdirSync(dir).filter((f) => f.endsWith('.call.json'));
    expect(written).toEqual(['inst-self.------escaped.call.json']);
    expect(existsSync(join(dir, '..', '..', 'escaped.call.json'))).toBe(false);
    await hooks.dispose();
  });

  it('dispose removes the tickets along with everything else', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' });
    await hooks.dispose();
    expect(readdirSync(dir).filter((f) => f.endsWith('.call.json'))).toEqual([]);
  });

  it('dispose removes the caller file along with the records', async () => {
    const hooks = await startPlugin(deps());
    await hooks['tool.execute.before']({ tool: 'tincan_peers', sessionID: 'ses_caller', callID: 'c1' });
    await hooks.dispose();
    expect(existsSync(join(dir, 'inst-self.caller.json'))).toBe(false);
  });
});
