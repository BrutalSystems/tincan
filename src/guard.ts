/**
 * Loop guard (§8.3, §8.4), enforced here rather than trusted to either harness.
 * Claude Code rate-limits its own peer inbox; `codex queue` does not, and every
 * Codex send starts a turn on an idle thread — so Codex gets a tighter budget.
 */

export interface GuardLimits {
  /** Sends to one peer per rolling minute. */
  perMinute: number;
  /** Window in which an identical repeat to the same peer is refused. */
  repeatWindowMs: number;
  /**
   * Runaway backstop: sends to one peer per `ceilingWindowMs`. Delivery is
   * fire-and-forget and tincan never observes a reply, so "queued" can only be
   * measured as sends without evidence of consumption.
   */
  maxQueued: number;
  ceilingWindowMs: number;
  maxChars: number;
}

export const CLAUDE_LIMITS: GuardLimits = {
  perMinute: 10,
  repeatWindowMs: 60_000,
  maxQueued: 50,
  ceilingWindowMs: 600_000,
  maxChars: 100_000,
};

export const CODEX_LIMITS: GuardLimits = {
  perMinute: 3,
  repeatWindowMs: 60_000,
  maxQueued: 20,
  ceilingWindowMs: 600_000,
  maxChars: 100_000,
};

// Same shape as Codex: like Codex, every opencode delivery starts or joins a
// turn, so it gets Codex's tighter budget rather than silently inheriting
// Claude's looser one.
export const OPENCODE_LIMITS: GuardLimits = {
  ...CODEX_LIMITS,
};

export type GuardReason = 'too_large' | 'identical_repeat' | 'rate_limited' | 'queue_full';

export type GuardVerdict =
  | { ok: true }
  | { ok: false; reason: GuardReason; detail: string };

interface Send {
  at: number;
  text: string;
}

export class Guard {
  private readonly sends = new Map<string, Send[]>();

  constructor(
    private readonly limits: GuardLimits,
    private readonly now: () => number = Date.now,
  ) {}

  check(peer: string, text: string): GuardVerdict {
    const { limits } = this;
    if (text.length > limits.maxChars) {
      return {
        ok: false,
        reason: 'too_large',
        detail:
          `Message is ${text.length} characters; the cap is ${limits.maxChars}. ` +
          `Send a summary or a file path instead.`,
      };
    }

    const history = this.history(peer);
    const t = this.now();

    if (history.some((s) => s.text === text && t - s.at < limits.repeatWindowMs)) {
      return {
        ok: false,
        reason: 'identical_repeat',
        detail:
          `An identical message was sent to ${peer} in the last ` +
          `${Math.round(limits.repeatWindowMs / 1000)}s and was dropped. ` +
          `Do not resend it; wait for the peer, or send different text.`,
      };
    }

    if (history.filter((s) => t - s.at < 60_000).length >= limits.perMinute) {
      return {
        ok: false,
        reason: 'rate_limited',
        detail:
          `Rate limit: ${limits.perMinute} messages/minute to ${peer}. ` +
          `This message was dropped. Do not resend immediately.`,
      };
    }

    if (history.filter((s) => t - s.at < limits.ceilingWindowMs).length >= limits.maxQueued) {
      return {
        ok: false,
        reason: 'queue_full',
        detail:
          `${limits.maxQueued} messages already sent to ${peer} in the last ` +
          `${Math.round(limits.ceilingWindowMs / 60_000)} minutes with no evidence of ` +
          `consumption. This message was dropped. Do not resend; something is looping.`,
      };
    }

    return { ok: true };
  }

  record(peer: string, text: string): void {
    this.history(peer).push({ at: this.now(), text });
  }

  /** Drops entries older than the widest window so the map cannot grow forever. */
  private history(peer: string): Send[] {
    const cutoff = this.now() - this.limits.ceilingWindowMs;
    const kept = (this.sends.get(peer) ?? []).filter((s) => s.at >= cutoff);
    this.sends.set(peer, kept);
    return kept;
  }
}
