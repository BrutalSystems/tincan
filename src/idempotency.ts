/**
 * Caller-supplied idempotency keys, so a retry cannot deliver twice.
 *
 * The message id Tin Can mints is generated *inside* `send_peer`, after the
 * arguments have been accepted, so it identifies a delivery and not an intent —
 * two calls produce two ids and two deliveries. A key supplied by the caller is
 * the only thing that can span the two attempts, because only the caller knows
 * they were the same attempt.
 *
 * Deliberately in-memory and deliberately bounded. This is not a durable
 * exactly-once guarantee and must not be described as one: a Tin Can restart
 * forgets every key, and a key that ages out of the window and is then reused
 * will deliver again. Both are acceptable at this size — the case being
 * defended against is a retry minutes later in the same session, not a
 * replay days later — but they are the reason the window is stated in the tool
 * description rather than left to be discovered.
 */

/**
 * How long a key is remembered. Long enough to cover a human noticing an
 * interrupted turn and resuming it; short enough that the map stays small and
 * a key reused much later is treated as new rather than mysteriously refused.
 */
export const IDEMPOTENCY_WINDOW_MS = 600_000;

export interface PriorSend {
  /** The id of the message the first call actually sent. */
  messageId: string;
  /** Display name of the peer it went to, for the refusal text. */
  peer: string;
  /**
   * The peer address the caller actually typed, which is what a repeat is
   * compared against. Comparing the resolved peer instead would call a retry
   * "the same" after the name had been reassigned to a different session.
   */
  peerArg: string;
  text: string;
  at: number;
}

export class IdempotencyStore {
  private readonly seen = new Map<string, PriorSend>();

  constructor(
    private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The prior send under this key, if one is still inside the window.
   *
   * Prunes on every call: there is no background timer, so eviction has to ride
   * on the read path or the map is a leak in a long-lived process.
   */
  lookup(key: string): PriorSend | undefined {
    const cutoff = this.now() - this.windowMs;
    for (const [k, prior] of this.seen) {
      if (prior.at < cutoff) this.seen.delete(k);
    }
    return this.seen.get(key);
  }

  /**
   * Recorded only after a delivery actually succeeded.
   *
   * A failed send must not burn the key: the caller's correct response to a
   * transient failure is to retry under the same key, and recording on attempt
   * would turn the first flake into a permanent refusal.
   */
  record(key: string, send: Omit<PriorSend, 'at'>): void {
    this.seen.set(key, { ...send, at: this.now() });
  }
}
