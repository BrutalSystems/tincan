import { describe, test, expect } from 'vitest';
import { listCodexPeers, type CodexEnv, type CodexThread } from '../src/codex/discover.js';

const thread = (over: Partial<CodexThread> = {}): CodexThread => ({
  id: '00000000-0000-0000-0000-000000000aaa',
  name: 'Auth refactor',
  cwd: '/src/auth',
  status: 'idle',
  ephemeral: false,
  canAcceptDirectInput: true,
  ...over,
});

const env = (over: Partial<CodexEnv> = {}): CodexEnv => ({
  probe: async () => ({ ok: true }),
  readThread: async () => ({ ok: true, source: 'cli' }),
  listThreads: async () => [thread()],
  liveThreads: async () => new Map([['00000000-0000-0000-0000-000000000aaa', {}]]),
  queue: async () => ({ ok: true }),
  ...over,
});

describe('listCodexPeers', () => {
  test('lists a thread that a live process is holding open', async () => {
    const { peers } = await listCodexPeers(env());
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ rawName: 'Auth refactor', cwd: '/src/auth', state: 'idle' });
  });

  test('omits a saved thread nobody has open — it is history, not a peer', async () => {
    const { peers } = await listCodexPeers(env({ liveThreads: async () => new Map() }));
    expect(peers).toEqual([]);
  });

  test('reports a busy thread as busy', async () => {
    const { peers } = await listCodexPeers(
      env({ listThreads: async () => [thread({ status: 'running' })] }),
    );
    expect(peers[0]!.state).toBe('busy');
  });

  test('treats an ephemeral thread as unreachable rather than an error', async () => {
    const { peers } = await listCodexPeers(
      env({ listThreads: async () => [thread({ ephemeral: true })] }),
    );
    expect(peers[0]!.state).toBe('unreachable');
  });

  test('treats a thread that rejects direct input as unreachable', async () => {
    const { peers } = await listCodexPeers(
      env({ listThreads: async () => [thread({ canAcceptDirectInput: false })] }),
    );
    expect(peers[0]!.state).toBe('unreachable');
  });

  test('carries the thread id through for the send path', async () => {
    const { peers } = await listCodexPeers(env());
    expect(peers[0]!.threadId).toBe('00000000-0000-0000-0000-000000000aaa');
  });
});

describe('a freshly started session', () => {
  test('is listed even though thread/list does not know it yet', async () => {
    // A Codex thread reaches thread/list only after its first turn, but it holds
    // its writer lock from launch. Liveness is the lock, not the listing.
    const { peers } = await listCodexPeers(
      env({
        listThreads: async () => [],
        liveThreads: async () => new Map([['01a0b995-2fbc-7671-9901-77f1832cb3b1', {}]]),
      }),
    );
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      threadId: '01a0b995-2fbc-7671-9901-77f1832cb3b1',
      rawName: null,
    });
  });

  test('is unreachable until its first turn, because it has no rollout to queue against', async () => {
    const { peers, diagnostic } = await listCodexPeers(
      env({
        listThreads: async () => [],
        readThread: async () => ({ ok: false, error: 'no rollout found for thread id 01a0…' }),
        liveThreads: async () => new Map([['01a0b995-2fbc-7671-9901-77f1832cb3b1', {}]]),
      }),
    );
    expect(peers[0]!.state).toBe('unreachable');
    expect(diagnostic).toMatch(/first turn|no rollout/i);
  });

  test('takes its working directory from the process holding the lock', async () => {
    const { peers } = await listCodexPeers(
      env({
        listThreads: async () => [],
        liveThreads: async () =>
          new Map([['01a0b995-2fbc-7671-9901-77f1832cb3b1', { cwd: '/Users/mike/Source/brutalsystems' }]]),
      }),
    );
    expect(peers[0]!.cwd).toBe('/Users/mike/Source/brutalsystems');
  });

  test('prefers thread/list metadata once the thread has one', async () => {
    const { peers } = await listCodexPeers(
      env({
        listThreads: async () => [thread({ id: '01a0b995-2fbc-7671-9901-77f1832cb3b1', name: 'Auth refactor', cwd: '/src/auth' })],
        liveThreads: async () =>
          new Map([['01a0b995-2fbc-7671-9901-77f1832cb3b1', { cwd: '/some/other/place' }]]),
      }),
    );
    expect(peers[0]).toMatchObject({ rawName: 'Auth refactor', cwd: '/src/auth' });
  });
});

describe('reachability comes from thread/read, not thread/list', () => {
  test('a headless `codex exec` thread is unreachable: it accepts input and never reads it', async () => {
    const { peers, diagnostic } = await listCodexPeers(
      env({
        listThreads: async () => [],
        readThread: async () => ({ ok: true, source: 'exec' }),
        liveThreads: async () => new Map([['00000000-0000-0000-0000-000000000aaa', {}]]),
      }),
    );
    expect(peers[0]!.state).toBe('unreachable');
    expect(diagnostic).toMatch(/exec/i);
  });

  test('a thread absent from thread/list is still reachable when it reads back fine', async () => {
    // thread/list filters by source, so absence is not evidence of unreachability.
    const { peers } = await listCodexPeers(
      env({
        listThreads: async () => [],
        readThread: async () => ({ ok: true, source: 'cli' }),
        liveThreads: async () => new Map([['00000000-0000-0000-0000-000000000aaa', {}]]),
      }),
    );
    expect(peers[0]!.state).toBe('idle');
  });

  test('a thread with no rollout yet is unreachable, with the first-turn reason', async () => {
    const { peers, diagnostic } = await listCodexPeers(
      env({
        listThreads: async () => [],
        readThread: async () => ({ ok: false, error: 'no rollout found for thread id 01a0…' }),
        liveThreads: async () => new Map([['00000000-0000-0000-0000-000000000aaa', {}]]),
      }),
    );
    expect(peers[0]!.state).toBe('unreachable');
    expect(diagnostic).toMatch(/first turn/i);
  });
});

describe('when Codex is unavailable', () => {
  test('returns a diagnostic naming the fix, never a bare empty list', async () => {
    const { peers, diagnostic } = await listCodexPeers(
      env({ probe: async () => ({ ok: false, diagnostic: 'codex CLI not found on PATH' }) }),
    );
    expect(peers).toEqual([]);
    expect(diagnostic).toContain('codex');
  });

  test('does not try to enumerate threads when the probe failed', async () => {
    let called = false;
    await listCodexPeers(
      env({
        probe: async () => ({ ok: false, diagnostic: 'no codex' }),
        listThreads: async () => {
          called = true;
          return [];
        },
      }),
    );
    expect(called).toBe(false);
  });
});
