/**
 * The real CodexEnv: one long-lived `codex app-server --listen stdio://` child,
 * spoken to over JSONL.
 *
 * `initialize` must declare `experimentalApi: true` — the thread/queue/* family
 * is gated on it and the daemon withholds the methods otherwise. This works
 * without an app-server *daemon* or control socket: the queue is shared state,
 * so a thread that is not loaded in our process still receives the submission.
 */
import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { CodexEnv, CodexThread, LiveThreadInfo, ThreadRead } from './discover.js';

export interface CodexEnvOptions {
  path?: string;
  lockDir?: string;
  codexHome?: string;
  timeoutMs?: number;
}

interface RpcMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 semantics with the "jsonrpc" member omitted, one message per line. */
class AppServer {
  private child?: ChildProcessByStdio<Writable, Readable, null>;
  private ready?: Promise<void>;
  private nextId = 0;
  private buf = '';
  private readonly pending = new Map<number, (m: RpcMessage) => void>();

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs: number,
  ) {}

  async call(method: string, params: unknown): Promise<RpcMessage> {
    await this.ensure();
    return this.send(method, params);
  }

  dispose(): void {
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.child = undefined;
    this.ready = undefined;
  }

  private ensure(): Promise<void> {
    if (this.ready !== undefined) return this.ready;
    this.ready = (async () => {
      const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: this.env,
      });
      this.child = child;

      child.stdout.on('data', (d: Buffer) => this.onData(d));
      const reset = () => {
        for (const resolve of this.pending.values()) {
          resolve({ error: { code: -32000, message: 'app-server exited' } });
        }
        this.pending.clear();
        this.child = undefined;
        this.ready = undefined;
      };
      child.on('error', reset);
      child.on('exit', reset);

      await this.send('initialize', {
        clientInfo: { name: 'tincan', title: 'Tin Can', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
    })();
    return this.ready;
  }

  private onData(d: Buffer): void {
    this.buf += d.toString();
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim() === '') continue;
      let m: RpcMessage;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.id === 'number' && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    }
  }

  private send(method: string, params: unknown): Promise<RpcMessage> {
    return new Promise((resolve) => {
      const id = ++this.nextId;
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: { code: -32001, message: `timed out calling ${method}` } });
        }
      }, this.timeoutMs);
      this.child?.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
}

export function createCodexEnv(opts: CodexEnvOptions = {}): CodexEnv {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const lockDir = opts.lockDir ?? join(codexHome, 'thread-writer-locks');
  const env = { ...process.env, ...(opts.path !== undefined && { PATH: opts.path }) };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const server = new AppServer(env, timeoutMs);

  return {
    async probe() {
      const found = await new Promise<boolean>((resolve) => {
        execFile('codex', ['--version'], { env, timeout: 10_000 }, (err) => resolve(!err));
      });
      return found
        ? { ok: true }
        : {
            ok: false,
            diagnostic:
              'No usable `codex` on PATH, so Codex peers cannot be listed or reached. ' +
              'Install the Codex CLI, or make sure it is not shadowed in this session.',
          };
    },

    async listThreads() {
      const res = await server.call('thread/list', { limit: 50, useStateDbOnly: true });
      const data = res.result?.data;
      return Array.isArray(data) ? data.map(toThread) : [];
    },

    async readThread(threadId): Promise<ThreadRead> {
      const res = await server.call('thread/read', { threadId });
      if (res.error) return { ok: false, error: res.error.message };
      const thread = (res.result?.thread ?? res.result) as Record<string, unknown> | undefined;
      const source = thread?.source;
      return { ok: true, ...(typeof source === 'string' && { source }) };
    },

    async liveThreads() {
      const live = new Map<string, LiveThreadInfo>();
      if (!existsSync(lockDir)) return live;

      const locks = readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
      await Promise.all(
        locks.map(async (file) => {
          const threadId = file.replace(/\.lock$/, '');
          // A lock file outlives its process; only a real holder means a live
          // session. The holder's cwd names the session for a thread that has
          // not taken a turn yet and so has no thread/list metadata.
          const pid = await run('lsof', ['-t', join(lockDir, file)], env);
          const holder = pid.split('\n')[0]?.trim();
          if (!holder) return;
          const cwd = await processCwd(holder, env);
          live.set(threadId, {
            ...(cwd !== undefined && { cwd }),
            ...(Number.isFinite(Number(holder)) && { pid: Number(holder) }),
          });
        }),
      );
      return live;
    },

    async queue(threadId, text) {
      const res = await server.call('thread/queue/add', {
        threadId,
        input: [{ type: 'text', text, textElements: [] }],
        clientUserMessageId: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      });
      if (res.error) return { ok: false, error: explain(res.error) };
      return { ok: true };
    },
  };
}

/** Turn a protocol error into something the sending agent can act on. */
function explain(error: { code: number; message: string }): string {
  if (error.code === -32601) {
    return (
      `This Codex build does not implement thread/queue/add (${error.message}). ` +
      `Upgrade the codex CLI.`
    );
  }
  if (error.code === -32600 && /experimentalApi/i.test(error.message)) {
    return (
      `Codex withheld the experimentalApi capability, which thread/queue/add requires ` +
      `(${error.message}). Upgrade the codex CLI, or enable the experimental API for it.`
    );
  }
  return error.message;
}

function toThread(raw: unknown): CodexThread {
  const t = raw as Record<string, unknown>;
  return {
    id: String(t.id ?? ''),
    name: typeof t.name === 'string' && t.name !== '' ? t.name : null,
    cwd: String(t.cwd ?? ''),
    ...(t.status !== undefined && { status: String(t.status) }),
    ...(typeof t.ephemeral === 'boolean' && { ephemeral: t.ephemeral }),
    ...(typeof t.canAcceptDirectInput === 'boolean' && {
      canAcceptDirectInput: t.canAcceptDirectInput,
    }),
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 10_000 }, (_err, stdout) => resolve(String(stdout)));
  });
}

/** Parent pid of a process, for walking up to our Codex host. */
export function parentPidLookup(env: NodeJS.ProcessEnv) {
  return async (pid: number): Promise<number | undefined> => {
    const out = await run('ps', ['-o', 'ppid=', '-p', String(pid)], env);
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
}

/** `lsof -Fn` prints the cwd on an `n`-prefixed line. */
async function processCwd(pid: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const out = await run('lsof', ['-a', '-d', 'cwd', '-p', pid, '-Fn'], env);
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1).trim();
  }
  return undefined;
}
