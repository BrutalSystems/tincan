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

    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 999 });
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
    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 111 });
    expect(peers).toEqual([]);
  });

  test('reports a session whose socket refuses the connection as unreachable', async () => {
    const dead = await fakeInbox({ accept: false });
    open.push(dead);
    writeSession(111, { messagingSocketPath: dead.path });
    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 999 });
    expect(peers[0]!.state).toBe('unreachable');
  });

  test('loads the peer token from the per-session key file', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { messagingSocketPath: inbox.path }, 'b'.repeat(32));
    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 999 });
    expect(peers[0]!.auth?.peerToken).toBe('b'.repeat(32));
  });

  test('still lists a session whose key file is missing, with no auth', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { messagingSocketPath: inbox.path });
    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 999 });
    expect(peers[0]!.auth).toBeUndefined();
  });

  test('maps a session waiting on its human to busy, not idle', async () => {
    const inbox = await fakeInbox();
    open.push(inbox);
    writeSession(111, { status: 'busy', messagingSocketPath: inbox.path });
    const { sessions: peers } = await listClaudeSessions({ registryDirs: [join(dir, 'sessions')], selfPid: 999 });
    expect(peers[0]!.state).toBe('busy');
  });
});

describe('several registry dirs', () => {
  let a: string;
  let b: string;

  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), 'tincan-a-'));
    b = mkdtempSync(join(tmpdir(), 'tincan-b-'));
    mkdirSync(join(a, 'sessions'), { recursive: true });
    mkdirSync(join(b, 'sessions'), { recursive: true });
  });
  afterEach(() => {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  function write(root: string, pid: number, fields: Record<string, unknown> = {}) {
    writeFileSync(
      join(root, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: `0000${pid}-0000-0000-0000-000000000000`,
        cwd: '/src/thing',
        name: `session-${pid}`,
        status: 'idle',
        ...fields,
      }),
    );
  }

  test('lists sessions from every dir, and tags each with where it came from', async () => {
    const one = await fakeInbox();
    const two = await fakeInbox();
    open.push(one, two);
    write(a, 111, { messagingSocketPath: one.path });
    write(b, 222, { messagingSocketPath: two.path });

    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions'), join(b, 'sessions')],
      selfPid: 1,
    });

    expect(listing.sessions.map((s) => s.pid).sort()).toEqual([111, 222]);
    expect(listing.sessions.find((s) => s.pid === 222)?.registryDir).toBe(join(b, 'sessions'));
    expect(listing.sessions.find((s) => s.pid === 222)?.configDir).toBe(b);
  });

  test('reports every pid it accounted for, including unreachable ones', async () => {
    write(a, 111, { messagingSocketPath: join(a, 'gone.sock') });
    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions')],
      selfPid: 1,
      probeMs: 50,
    });
    expect(listing.accountedPids.has(111)).toBe(true);
  });

  test('a dir that does not exist is skipped, not thrown on', async () => {
    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions'), '/definitely/not/here'],
      selfPid: 1,
    });
    expect(listing.sessions).toEqual([]);
  });

  test('the same pid in two dirs: procStart picks the live one', async () => {
    const sock = await fakeInbox();
    open.push(sock);
    write(a, 333, { messagingSocketPath: sock.path, procStart: 'STALE', name: 'stale-one' });
    write(b, 333, { messagingSocketPath: sock.path, procStart: 'LIVE', name: 'live-one' });

    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions'), join(b, 'sessions')],
      selfPid: 1,
      liveProcStart: () => 'LIVE',
    });

    expect(listing.sessions).toHaveLength(1);
    expect(listing.sessions[0]?.rawName).toBe('live-one');
  });

  test('the same pid in two dirs, neither matching: both dropped, with a diagnostic', async () => {
    const sock = await fakeInbox();
    open.push(sock);
    write(a, 444, { messagingSocketPath: sock.path, procStart: 'ONE' });
    write(b, 444, { messagingSocketPath: sock.path, procStart: 'TWO' });

    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions'), join(b, 'sessions')],
      selfPid: 1,
      liveProcStart: () => 'NEITHER',
    });

    expect(listing.sessions).toEqual([]);
    expect(listing.diagnostic).toContain('444');
    expect(listing.accountedPids.has(444)).toBe(true);
  });

  test('the same pid in two dirs with no procStart anywhere: both dropped', async () => {
    const sock = await fakeInbox();
    open.push(sock);
    write(a, 555, { messagingSocketPath: sock.path });
    write(b, 555, { messagingSocketPath: sock.path });

    const listing = await listClaudeSessions({
      registryDirs: [join(a, 'sessions'), join(b, 'sessions')],
      selfPid: 1,
      liveProcStart: () => undefined,
    });

    expect(listing.sessions).toEqual([]);
    expect(listing.diagnostic).toContain('555');
  });
});
