/**
 * Claude Code inbox client (§6), written against the 2.1.267 wire format
 * verified on this machine — not the shape in the handoff, which predates it:
 *
 *   {"type":"auth","peerToken":"<32 hex>","procStart":…,"pidDomain":…}
 *   {"type":"user","message":{"role":"user","content":"…"},"priority":"next","msg_id":"…"}
 *
 * A frame without `type` is logged as "Ignoring message without valid type
 * field" and silently dropped.
 */
import net from 'node:net';

/**
 * Statuses that mean the message was dropped and nothing will deliver it.
 *
 * Deliberately a closed set rather than "anything that is not `held`": a status
 * Tin Can has never seen carries no established meaning, and guessing that it
 * means failure is the same overclaim in the other direction. `refuse` and
 * `refused` are both listed because the settings key is `crossSessionInbound:
 * "refuse"` while the outcome it produces is named "refused", and either spelling
 * reaching the wire means the same thing.
 */
const REFUSAL_STATUSES = new Set(['refused', 'refuse', 'rejected', 'dropped']);

export interface InboxAuth {
  peerToken: string;
  procStart?: string;
  pidDomain?: string;
}

export interface SendToInboxParams {
  socketPath: string;
  auth: InboxAuth | undefined;
  text: string;
  msgId: string;
  /** How long to wait for a hold receipt before closing. */
  receiptMs?: number;
}

export interface SendToInboxResult {
  delivered: boolean;
  unreachable?: boolean;
  notice?: string;
  error?: string;
}

export function sendToInbox(params: SendToInboxParams): Promise<SendToInboxResult> {
  const { socketPath, auth, text, msgId, receiptMs = 300 } = params;

  return new Promise((resolve) => {
    let settled = false;
    let notice: string | undefined;
    let refused = false;
    let buf = '';

    const finish = (r: SendToInboxResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    const conn = net.createConnection(socketPath);

    conn.on('connect', () => {
      // Connect only when the text is ready: an idle connection is closed at 30s.
      if (auth) conn.write(JSON.stringify({ type: 'auth', ...auth }) + '\n');
      conn.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: text },
          priority: 'next',
          msg_id: msgId,
        }) + '\n',
      );
      setTimeout(
        () => finish({ delivered: !refused, ...(notice !== undefined && { notice }) }),
        receiptMs,
      );
    });

    conn.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim() === '') continue;
        let frame: { type?: string; orig_msg_id?: string; status?: string; detail?: string };
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame.type === 'peer_message_status' && frame.orig_msg_id === msgId) {
          // A hold is not a failure (§6): the peer's human may still release it.
          //
          // A refusal is. Claude Code's inbound controls end in one of three
          // states — delivered, held, refused — and a refusal means the message
          // was dropped without reaching the receiving Claude. Reporting that as
          // `delivered` with a note attached claims more than was established.
          //
          // Only a KNOWN refusal flips the verdict. An unrecognised status stays
          // a notice, because the alternative — treating anything unfamiliar as
          // failure — would report a delivered message as failed the first time
          // Claude Code adds a fourth state, and a caller acting on that would
          // resend a message the peer already has.
          if (frame.status !== undefined && REFUSAL_STATUSES.has(frame.status.toLowerCase())) {
            refused = true;
          }
          notice = `receiver ${frame.status ?? 'reported'} message${frame.detail ? `: ${frame.detail}` : ''}`;
        }
      }
    });

    conn.on('error', (e: NodeJS.ErrnoException) => {
      const gone = e.code === 'ECONNREFUSED' || e.code === 'ENOENT';
      finish({ delivered: false, unreachable: gone, error: e.message });
    });
  });
}
