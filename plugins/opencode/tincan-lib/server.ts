import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { socketPathTooLong } from './paths.js';
import { MAX_LINE_BYTES } from './wire.js';

export interface ListenOptions {
  path: string;
  onLine: (line: string) => void;
  onError: (err: unknown) => void;
}

export interface ServerHandle {
  close(): Promise<void>;
}

// A caller's onError can itself throw (a broken logging sink, say). That must
// never propagate out of a synchronous EventEmitter callback either — SPEC
// §8.1 is absolute, and this module is its strictest instance.
function safeOnError(opts: ListenOptions, err: unknown): void {
  try {
    opts.onError(err);
  } catch {
    // Swallowed deliberately: an error handler's own failure must never
    // reach the host.
  }
}

function frame(socket: Socket, opts: ListenOptions): void {
  socket.setEncoding('utf8');
  let buf = '';
  let overflowed = false;

  const emit = (line: string) => {
    if (line.length === 0) return;
    try {
      opts.onLine(line);
    } catch (e) {
      // A handler failure must never reach the host. SPEC §8.1.
      safeOnError(opts, e);
    }
  };

  socket.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (overflowed) { overflowed = false; continue; }
      if (Buffer.byteLength(line, 'utf8') >= MAX_LINE_BYTES) {
        safeOnError(opts, new Error('oversize line dropped'));
        continue;
      }
      emit(line);
    }
    if (Buffer.byteLength(buf, 'utf8') >= MAX_LINE_BYTES) {
      safeOnError(opts, new Error('oversize line dropped'));
      buf = '';
      overflowed = true;
    }
  });

  socket.on('end', () => {
    if (!overflowed && buf.length > 0) emit(buf);
    buf = '';
  });
  socket.on('error', (e) => safeOnError(opts, e));
}

export async function listenLines(opts: ListenOptions): Promise<ServerHandle> {
  if (socketPathTooLong(opts.path)) {
    throw new Error(`socket path too long (${Buffer.byteLength(opts.path)} bytes): ${opts.path}`);
  }
  const dir = dirname(opts.path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is ignored when the directory already exists, and this
  // parent is shared across every instance and every restart — so without
  // an unconditional chmod, the 0700 protection SPEC §8.3 calls load-bearing
  // only ever applies on a machine's first run. Matches registry.ts's
  // writeRecord.
  await chmod(dir, 0o700);
  try {
    await unlink(opts.path);
  } catch {
    // Nothing there is the common case.
  }

  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    frame(socket, opts);
  });
  server.on('error', (e) => safeOnError(opts, e));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => resolve());
  });

  // Neither node:net nor Bun.listen honours 0600 on creation. SPEC §4.
  await chmod(opts.path, 0o600);

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      // server.close() only stops new connections and waits for existing
      // ones to end on their own — it never terminates them. A single idle
      // peer would otherwise wedge this forever, and SPEC §8.1 names
      // wedging the user's session as worse than a missed message.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(opts.path);
      } catch {
        // Already gone.
      }
    },
  };
}

/** The liveness test the whole staleness model rests on. SPEC §6. */
export function probeSocket(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch { /* already gone */ }
      resolve(alive);
    };
    const c = connect(path);
    c.setTimeout(timeoutMs, () => finish(false));
    c.on('connect', () => finish(true));
    c.on('error', () => finish(false));
  });
}
