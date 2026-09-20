/**
 * opencode instance socket client (SPEC.md §7 / change-notice-opencode.md §3).
 *
 * The plugin inside opencode binds one Unix socket per instance and accepts
 * exactly one JSON object per connection, on one line, then the connection is
 * closed. No auth line — the socket is created `0600`, owner-only. No
 * response is written, so delivery is "did the write land," not "did opencode
 * act on it."
 *
 * Tin Can never speaks HTTP to opencode; this socket is the only path.
 */
import net from 'node:net';

export interface SendToInstanceParams {
  socketPath: string;
  /** Must match ^ses — opencode's own session id. */
  toSession: string;
  /** Sender's Tin Can name. Logging only on the opencode side. */
  from: string;
  /** Already enveloped by Tin Can (buildEnvelope/renderEnvelope). Passed through verbatim. */
  text: string;
  delivery: 'queue' | 'steer';
  /** Must match ^msg_ — opencode's server enforces this and 400s otherwise. */
  messageId: string;
  /**
   * How long to wait for the peer to close its side (SPEC §7's implicit ack)
   * before falling back to a written-or-not verdict rather than hanging
   * forever. Exposed only so tests can shrink it; production keeps the
   * default.
   */
  fallbackMs?: number;
}

export interface SendToInstanceResult {
  delivered: boolean;
  error?: string;
  unreachable?: boolean;
}

export function sendToInstance(
  params: SendToInstanceParams,
  // `connect` exists only so a test can double a socket that never fires
  // 'connect' at all — the "contested accept queue" half of the fallback
  // this function relies on cannot be reproduced deterministically with a
  // real AF_UNIX socket (Node/libuv drain the kernel accept queue eagerly
  // regardless of backlog size, so a real connect either succeeds or fails
  // near-instantly; it does not hang). Production never passes this.
  deps: { connect?: (socketPath: string) => net.Socket } = {},
): Promise<SendToInstanceResult> {
  const { socketPath, toSession, from, text, delivery, messageId, fallbackMs = 500 } = params;
  const { connect = net.createConnection } = deps;

  return new Promise((resolve) => {
    let settled = false;
    let wrote = false;
    const finish = (r: SendToInstanceResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    const conn = connect(socketPath);

    // A courteous end() rather than a destroy(): with the default
    // allowHalfOpen:false, the peer closes its own side once it has read our
    // line, which is what the 'close' handler below resolves on — a
    // deterministic signal that the bytes actually reached the peer's socket
    // buffer, rather than merely our local write completing.
    //
    // The fallback timer covers two distinct stalls under one deadline: a
    // connection that never completes at all (a contested accept queue is
    // plausible — one instance socket serves many sessions and can take
    // concurrent deliveries), and one that connects and is written to but
    // whose peer never closes its side. `wrote` is what tells those apart:
    // only a completed write may count as delivered when the deadline hits.
    // Resolving `delivered: true` unconditionally here would report success
    // for a message that was never even written to the socket — a false
    // positive that nothing downstream (Tin Can's own log included) could
    // ever contradict.
    const fallback = setTimeout(() => {
      finish(wrote ? { delivered: true } : { delivered: false, unreachable: true });
    }, fallbackMs);

    conn.on('connect', () => {
      const line =
        JSON.stringify({
          to_session: toSession,
          message_from: from,
          text,
          delivery,
          message_id: messageId,
        }) + '\n';
      conn.end(line);
      wrote = true;
    });

    conn.on('close', () => finish({ delivered: true }));

    conn.on('error', (e: NodeJS.ErrnoException) => {
      // ECONNREFUSED: a dead instance's leftover socket (SPEC §6). ENOENT: no
      // socket at that path at all. Either way this is the registry's problem
      // to prune, not a throw.
      const gone = e.code === 'ECONNREFUSED' || e.code === 'ENOENT';
      finish({ delivered: false, error: e.message, ...(gone && { unreachable: true }) });
    });
  });
}
