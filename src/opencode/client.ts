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
}

export interface SendToInstanceResult {
  delivered: boolean;
  error?: string;
  unreachable?: boolean;
}

export function sendToInstance(params: SendToInstanceParams): Promise<SendToInstanceResult> {
  const { socketPath, toSession, from, text, delivery, messageId } = params;

  return new Promise((resolve) => {
    let settled = false;
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

    const conn = net.createConnection(socketPath);

    // A courteous end() rather than a destroy(): with the default
    // allowHalfOpen:false, the peer closes its own side once it has read our
    // line, which is what the 'close' handler below resolves on — a
    // deterministic signal that the bytes actually reached the peer's socket
    // buffer, rather than merely our local write completing. The fallback
    // timer exists only in case a peer implementation never closes its side.
    const fallback = setTimeout(() => finish({ delivered: true }), 500);

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
