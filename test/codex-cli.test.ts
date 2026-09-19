import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCodexEnv } from '../src/codex/cli.js';

let dir: string;
let rpcLog: string;

const lines = () =>
  readFileSync(rpcLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { pid: number; msg: { method: string; params: unknown } });

const calls = (method: string) => lines().filter((l) => l.msg.method === method);

/**
 * A stand-in `codex app-server`. It gates the experimental queue methods on the
 * capability the real daemon gates them on, and logs every request with its pid
 * so a test can tell one long-lived server from many short-lived ones.
 */
function installFakeCodex(
  opts: { grantExperimental?: boolean; queueError?: number; threadSource?: string } = {},
) {
  const body = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] !== 'app-server') { process.exit(0); }
let experimental = false;
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(process.env.TINCAN_RPC_LOG, JSON.stringify({ pid: process.pid, msg: m }) + '\\n');
    if (m.method === 'initialize') {
      experimental = m.params?.capabilities?.experimentalApi === true;
      send({ id: m.id, result: { userAgent: 'fake/0.0.0' } });
    } else if (m.method === 'thread/list') {
      send({ id: m.id, result: { data: [
        { id: 'aaa00000-0000-0000-0000-000000000aaa', name: 'Auth refactor', cwd: '/src/auth',
          status: 'idle', ephemeral: false, canAcceptDirectInput: true },
        { id: 'bbb00000-0000-0000-0000-000000000bbb', name: null, cwd: '/src/other',
          status: 'running', ephemeral: true, canAcceptDirectInput: false },
      ], nextCursor: null } });
    } else if (m.method === 'thread/read') {
      const src = ${JSON.stringify(opts.threadSource ?? 'cli')};
      if (src === 'MISSING') send({ id: m.id, error: { code: -32600,
        message: 'failed to read thread: no rollout found for thread id ' + m.params.threadId } });
      else send({ id: m.id, result: { thread: { id: m.params.threadId, source: src } } });
    } else if (m.method === 'thread/queue/add') {
      const forced = ${opts.queueError ?? 0};
      if (forced !== 0) {
        send({ id: m.id, error: { code: forced, message: forced === -32601
          ? 'method not found' : 'thread/queue/add requires experimentalApi capability' } });
      } else if (!experimental || !${opts.grantExperimental !== false}) {
        send({ id: m.id, error: { code: -32600,
          message: 'thread/queue/add requires experimentalApi capability' } });
      } else {
        send({ id: m.id, result: { queuedSubmission: { id: 'sub_1',
          clientUserMessageId: m.params.clientUserMessageId } } });
      }
    } else {
      send({ id: m.id, error: { code: -32601, message: 'no' } });
    }
  }
});
setTimeout(() => process.exit(0), 20000);
`;
  const bin = join(dir, 'codex');
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-codex-'));
  rpcLog = join(dir, 'rpc.log');
  writeFileSync(rpcLog, '');
  process.env.TINCAN_RPC_LOG = rpcLog;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TINCAN_RPC_LOG;
});

const envWithFake = () =>
  createCodexEnv({ path: `${dir}:${process.env.PATH}`, lockDir: join(dir, 'locks') });

describe('probe', () => {
  test('reports a diagnostic naming codex when the CLI is not on PATH', async () => {
    const env = createCodexEnv({ path: '/nonexistent', lockDir: join(dir, 'locks') });
    const r = await env.probe();
    expect(r.ok).toBe(false);
    expect(r.diagnostic).toContain('codex');
  });
});

describe('listThreads', () => {
  test('parses Thread records off the app-server', async () => {
    installFakeCodex();
    const threads = await envWithFake().listThreads();
    expect(threads.map((t) => t.name)).toEqual(['Auth refactor', null]);
    expect(threads[0]).toMatchObject({ cwd: '/src/auth', status: 'idle', canAcceptDirectInput: true });
    expect(threads[1]).toMatchObject({ ephemeral: true, canAcceptDirectInput: false });
  });

  test('declares experimentalApi at initialize, which the queue methods require', async () => {
    installFakeCodex();
    await envWithFake().listThreads();
    const init = calls('initialize')[0]!;
    expect((init.msg.params as { capabilities: { experimentalApi: boolean } }).capabilities.experimentalApi).toBe(true);
  });
});

describe('queue', () => {
  test('enqueues via thread/queue/add with the text as a UserInput element', async () => {
    installFakeCodex();
    const r = await envWithFake().queue('abc-123', 'hello peer');
    expect(r.ok).toBe(true);
    const add = calls('thread/queue/add')[0]!;
    expect(add.msg.params).toMatchObject({
      threadId: 'abc-123',
      input: [{ type: 'text', text: 'hello peer', textElements: [] }],
    });
  });

  test('sends a clientUserMessageId so the submission can be correlated', async () => {
    installFakeCodex();
    await envWithFake().queue('abc-123', 'hello');
    const add = calls('thread/queue/add')[0]!;
    expect((add.msg.params as { clientUserMessageId?: string }).clientUserMessageId).toMatch(/\S/);
  });

  test('reuses one app-server across calls rather than spawning per send', async () => {
    installFakeCodex();
    const env = envWithFake();
    await env.queue('abc-123', 'one');
    await env.queue('abc-123', 'two');
    const pids = new Set(lines().map((l) => l.pid));
    expect(pids.size).toBe(1);
    expect(calls('initialize')).toHaveLength(1);
  });

  test('surfaces a withheld experimentalApi capability as a named, actionable failure', async () => {
    installFakeCodex({ grantExperimental: false });
    const r = await envWithFake().queue('abc-123', 'hello');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('experimentalApi');
  });

  test('handles an older daemon that does not know the method at all', async () => {
    installFakeCodex({ queueError: -32601 });
    const r = await envWithFake().queue('abc-123', 'hello');
    expect(r.ok).toBe(false);
    expect(r.error?.toLowerCase()).toContain('codex');
  });
});

describe('readThread', () => {
  test('reports the source that decides whether a peer can actually be messaged', async () => {
    installFakeCodex({ threadSource: 'exec' });
    const r = await envWithFake().readThread('abc-123');
    expect(r).toEqual({ ok: true, source: 'exec' });
  });

  test('reports a thread with no rollout as a failed read, carrying the reason', async () => {
    installFakeCodex({ threadSource: 'MISSING' });
    const r = await envWithFake().readThread('abc-123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no rollout/i);
  });
});

describe('liveThreads', () => {
  test('is empty when the lock directory does not exist', async () => {
    installFakeCodex();
    expect((await envWithFake().liveThreads()).size).toBe(0);
  });

  test('ignores a lock file no process is holding', async () => {
    installFakeCodex();
    const locks = join(dir, 'locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, '01a0b995-2fbc-7671-9901-77f1832cb3b1.lock'), '');
    const live = await createCodexEnv({ path: `${dir}:${process.env.PATH}`, lockDir: locks }).liveThreads();
    expect(live.size).toBe(0);
  });

  test('reports a lock held by a running process, with that process working directory', async () => {
    installFakeCodex();
    const locks = join(dir, 'locks');
    mkdirSync(locks, { recursive: true });
    const lockPath = join(locks, '01a0b995-2fbc-7671-9901-77f1832cb3b1.lock');
    writeFileSync(lockPath, '');

    // A real process holding the file open, with a known cwd.
    const holder = spawn(
      process.execPath,
      ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(lockPath)},'r');setTimeout(()=>{},10000);`],
      { cwd: dir, stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 700));
    try {
      const live = await createCodexEnv({ path: `${dir}:${process.env.PATH}`, lockDir: locks }).liveThreads();
      expect([...live.keys()]).toEqual(['01a0b995-2fbc-7671-9901-77f1832cb3b1']);
      expect(live.get('01a0b995-2fbc-7671-9901-77f1832cb3b1')?.cwd).toContain('tincan-codex-');
    } finally {
      holder.kill('SIGKILL');
    }
  });
});
