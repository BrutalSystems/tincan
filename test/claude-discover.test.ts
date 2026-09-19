import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeInbox, type FakeInbox } from './fakes.js';
import { listClaudeSessions, socketDirCandidates } from '../src/claude/discover.js';

let dir: string;
let open: FakeInbox[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-reg-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
});
afterEach(async () => {
  for (const o of open) await o.close();
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(pid: number, fields: Record<string, unknown>, token?: string) {
  writeFileSync(
    join(dir, 'sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `0000${pid}-0000-0000-0000-000000000000`,
      cwd: '/src/thing',
      name: `session-${pid}`,
      status: 'idle',
      kind: 'interactive',
      ...fields,
    }),
  );
  if (token) {
    writeFileSync(
      join(dir, 'sessions', `${pid}.${'0'.repeat(64)}.key`),
      JSON.stringify({ peerToken: token, procStart: 'x', pidDomain: 'darwin' }),
    );
  }
}

describe('socketDirCandidates', () => {
  test('prefers XDG_RUNTIME_DIR, then /tmp/cc-socks, then the uid-suffixed fallback', () => {
    const c = socketDirCandidates({ XDG_RUNTIME_DIR: '/run/user/501' }, 501);
    expect(c[0]).toBe('/run/user/501/cc-socks');
    expect(c).toContain('/tmp/cc-socks');
    expect(c).toContain('/tmp/cc-socks-501');
  });

  test('still offers both /tmp shapes when XDG_RUNTIME_DIR is unset', () => {
    const c = socketDirCandidates({}, 501);
    expect(c).toEqual(['/tmp/cc-socks', '/tmp/cc-socks-501']);
  });
});

describe('listClaudeSessions', () => {
  test('reads name, cwd, session id and state from the session registry', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { name: 'billing-api', cwd: '/src/billing', messagingSocketPath: inbox.path });

    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 999 });
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      rawName: 'billing-api',
      cwd: '/src/billing',
      uuid: '0000111-0000-0000-0000-000000000000',
      state: 'idle',
    });
  });

  test('excludes the session tincan is hosted in', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { messagingSocketPath: inbox.path });
    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 111 });
    expect(peers).toEqual([]);
  });

  test('reports a session whose socket refuses the connection as unreachable', async () => {
    const dead = await fakeInbox({ accept: false });
    open.push(dead);
    writeSession(111, { messagingSocketPath: dead.path });
    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 999 });
    expect(peers[0]!.state).toBe('unreachable');
  });

  test('loads the peer token from the per-session key file', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { messagingSocketPath: inbox.path }, 'b'.repeat(32));
    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 999 });
    expect(peers[0]!.auth?.peerToken).toBe('b'.repeat(32));
  });

  test('still lists a session whose key file is missing, with no auth', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { messagingSocketPath: inbox.path });
    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 999 });
    expect(peers[0]!.auth).toBeUndefined();
  });

  test('maps a session waiting on its human to busy, not idle', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { status: 'busy', messagingSocketPath: inbox.path });
    const peers = await listClaudeSessions({ registryDir: join(dir, 'sessions'), selfPid: 999 });
    expect(peers[0]!.state).toBe('busy');
  });
});
