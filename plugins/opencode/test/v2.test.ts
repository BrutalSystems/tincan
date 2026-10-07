import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startV2, type V2Context } from '../tincan-lib/v2.js';
import { callerFile, callTicketFile } from '../tincan-lib/caller.js';

const DIR = '/repo';
let dir: string;
let logs: string[];

/** An event stream we push into, shaped like ctx.event.subscribe's. */
function stream() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
            signal?.addEventListener('abort', () => r(), { once: true });
          });
          continue;
        }
        yield queue.shift();
      }
    },
  };
  return {
    subscribe: vi.fn((opts?: { signal?: AbortSignal }) => { signal = opts?.signal; return iterable; }),
    push(e: unknown) { queue.push(e); wake?.(); },
    aborted: () => signal?.aborted === true,
  };
}

function fakeCtx(over: Partial<V2Context> = {}) {
  const events = stream();
  const hooks: Record<string, (e: unknown) => unknown> = {};
  const disposed: string[] = [];
  const ctx: V2Context = {
    location: { directory: DIR },
    session: { prompt: vi.fn(async (p: { id: string; sessionID: string }) => ({ id: p.id, sessionID: p.sessionID, type: 'user' })) },
    event: { subscribe: events.subscribe },
    tool: {
      hook: vi.fn(async (name: string, cb: (e: unknown) => unknown) => {
        hooks[name] = cb;
        return { dispose: () => { disposed.push(name); } };
      }),
    },
    ...over,
  };
  return { ctx, events, hooks, disposed };
}

const created = (sessionID: string, directory = DIR) => ({
  type: 'session.created',
  location: { directory },
  data: { sessionID, projectID: 'global', location: { directory }, subpath: '', slug: 'swift-eagle', version: '2.0.24' },
});

const start = (ctx: V2Context) =>
  startV2(ctx, { dir, instanceId: 'inst-self', pid: 4242, now: () => new Date(), sink: (l) => logs.push(l) });

/** Lets the subscription loop drain what was pushed. */
const settle = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

const ask = (sock: string, line: string): Promise<string> =>
  new Promise((resolve, reject) => {
    let buf = '';
    const c = net.createConnection(sock);
    c.on('connect', () => c.end(line + '\n'));
    c.on('data', (d) => { buf += d.toString(); });
    c.on('close', () => resolve(buf.trim()));
    c.on('error', reject);
    setTimeout(() => reject(new Error('timed out waiting for an ack')), 4000);
  });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tc-v2-')); logs = []; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('startV2', () => {
  it('advertises a session created in its own directory, from the event stream', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    const file = join(dir, 'ses_a.json');
    await settle(() => existsSync(file));
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    expect(rec).toMatchObject({
      session_id: 'ses_a', slug: 'swift-eagle', directory: DIR, state: 'idle',
      opencode_version: '2.0.24', instance_id: 'inst-self',
    });
    await cleanup();
  });

  it('does not advertise a session from another directory on the same server', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_x', '/elsewhere'));
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'ses_a.json')));
    expect(existsSync(join(dir, 'ses_x.json'))).toBe(false);
    await cleanup();
  });

  it('follows the title and the execution lifecycle', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    const file = join(dir, 'ses_a.json');
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
    events.push(created('ses_a'));
    events.push({ type: 'session.renamed', location: { directory: DIR }, data: { sessionID: 'ses_a', title: 'OK' } });
    events.push({ type: 'session.execution.started', data: { sessionID: 'ses_a' } });
    await settle(() => read().state === 'busy');
    expect(read()).toMatchObject({ title: 'OK', state: 'busy' });
    events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } });
    await settle(() => read().state === 'idle');
    expect(read().state).toBe('idle');
    await cleanup();
  });

  it('delivers a message through ctx.session.prompt and acks it', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'ses_a.json')));
    const text = '<peer_message from="billing-api" runtime="claude-code" id="msg_2">hi</peer_message>';
    const ack = JSON.parse(await ask(join(dir, 'inst-self.sock'), JSON.stringify({
      to_session: 'ses_a', message_from: 'billing-api', text, delivery: 'steer', message_id: 'msg_2',
    })));
    expect(ack).toMatchObject({ ok: true, message_id: 'msg_2', status: 'delivered' });
    expect(ctx.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_a', id: 'msg_2', text, delivery: 'steer' });
    await cleanup();
  });

  it('records the calling session from the tool hooks, reading the call id from `id`', async () => {
    const { ctx, events, hooks } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'ses_a.json')));
    const call = { tool: 'tincan_send_peer', sessionID: 'ses_a', agent: 'build', messageID: 'msg_m', id: 'call_1', input: {} };
    await hooks['execute.before']?.(call);
    expect(JSON.parse(readFileSync(callerFile(dir, 'inst-self'), 'utf8'))).toMatchObject({ session_id: 'ses_a' });
    expect(existsSync(callTicketFile(dir, 'inst-self', 'call_1'))).toBe(true);
    await hooks['execute.after']?.({ ...call, status: 'completed', result: {} });
    expect(existsSync(callTicketFile(dir, 'inst-self', 'call_1'))).toBe(false);
    await cleanup();
  });

  it('cleans up: stops the stream, drops its hooks and removes what it advertised', async () => {
    const { ctx, events, disposed } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'ses_a.json')));
    await cleanup();
    expect(events.aborted()).toBe(true);
    expect(disposed.sort()).toEqual(['execute.after', 'execute.before']);
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
  });

  it('binds nothing and advertises nothing when the context lacks session.prompt', async () => {
    const { ctx, events } = fakeCtx({ session: {} as V2Context['session'] });
    const cleanup = await start(ctx);
    expect(existsSync(join(dir, 'inst-self.sock'))).toBe(false);
    events.push(created('ses_a'));
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);
    expect(logs.join('\n')).toContain('selfcheck.failed');
    await cleanup();
  });

  it('never lets a broken event stream reach the host', async () => {
    const { ctx } = fakeCtx({
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() { throw new Error('stream died'); } }) },
    });
    const cleanup = await start(ctx);
    await settle(() => logs.join('\n').includes('stream died'));
    expect(logs.join('\n')).toContain('event=subscribe.failed');
    await cleanup();
  });
});

// opencode 2.x puts a session's slug on `session.created` and nowhere else —
// not on SessionInfo, not on any later event [verified 2.0.24]. So a session
// created before the background service last started could never be
// advertised again, whatever it did. The plugin remembers names itself.
describe('startV2 — sessions resumed after a service restart', () => {
  const resumable = (title = 'OK', directory = DIR) => fakeCtx({
    session: {
      prompt: vi.fn(async (p: { id: string; sessionID: string }) => ({ id: p.id, sessionID: p.sessionID })),
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title, location: { directory } })),
    },
  });

  it('remembers the name of a session it saw created', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'names', 'ses_a.json')));
    expect(JSON.parse(readFileSync(join(dir, 'names', 'ses_a.json'), 'utf8'))).toMatchObject({ slug: 'swift-eagle' });
    await cleanup();
  });

  it('re-advertises a remembered session on its first activity after a restart', async () => {
    const first = fakeCtx();
    const cleanup1 = await start(first.ctx);
    first.events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'names', 'ses_a.json')));
    await cleanup1(); // the service restarts: the record goes, the name stays
    expect(existsSync(join(dir, 'ses_a.json'))).toBe(false);

    const second = resumable('auth refactor');
    const cleanup2 = await start(second.ctx);
    second.events.push({ type: 'session.execution.started', data: { sessionID: 'ses_a' } });
    const file = join(dir, 'ses_a.json');
    await settle(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).state === 'busy');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      session_id: 'ses_a', slug: 'swift-eagle', title: 'auth refactor', directory: DIR, state: 'busy',
    });
    await cleanup2();
  });

  it('cannot advertise a session whose name it never saw, and does not ask opencode about it', async () => {
    const { ctx, events } = resumable();
    const cleanup = await start(ctx);
    events.push({ type: 'session.execution.started', data: { sessionID: 'ses_unknown' } });
    events.push(created('ses_b'));
    await settle(() => existsSync(join(dir, 'ses_b.json')));
    expect(existsSync(join(dir, 'ses_unknown.json'))).toBe(false);
    expect((ctx.session as unknown as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
    await cleanup();
  });

  it('leaves a session in another directory to that directory\'s instance', async () => {
    const first = fakeCtx({ location: { directory: '/elsewhere' } });
    const cleanup1 = await start(first.ctx);
    first.events.push(created('ses_x', '/elsewhere'));
    await settle(() => existsSync(join(dir, 'names', 'ses_x.json')));
    await cleanup1();

    const { ctx, events } = resumable('t', '/elsewhere');
    const cleanup2 = await start(ctx);
    events.push({ type: 'session.execution.started', data: { sessionID: 'ses_x' } });
    events.push(created('ses_b'));
    await settle(() => existsSync(join(dir, 'ses_b.json')));
    expect(existsSync(join(dir, 'ses_x.json'))).toBe(false);
    await cleanup2();
  });

  it('forgets the name when the session is deleted', async () => {
    const { ctx, events } = fakeCtx();
    const cleanup = await start(ctx);
    events.push(created('ses_a'));
    await settle(() => existsSync(join(dir, 'names', 'ses_a.json')));
    events.push({ type: 'session.deleted', location: { directory: DIR }, data: { sessionID: 'ses_a' } });
    await settle(() => !existsSync(join(dir, 'names', 'ses_a.json')));
    expect(existsSync(join(dir, 'names', 'ses_a.json'))).toBe(false);
    await cleanup();
  });
});
