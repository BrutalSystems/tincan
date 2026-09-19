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
  listThreads: async () => [thread()],
  liveThreadIds: async () => new Set(['00000000-0000-0000-0000-000000000aaa']),
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
    const { peers } = await listCodexPeers(env({ liveThreadIds: async () => new Set() }));
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
