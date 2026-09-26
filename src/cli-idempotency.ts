/**
 * A file-backed idempotency store, for `tincan send` only.
 *
 * `IdempotencyStore` is in-memory, and its own docstring scopes that correctly:
 * "a Tin Can restart forgets every key… the case being defended against is a
 * retry minutes later in the same session." For a hosted server that is true and
 * sufficient — the retry arrives in the same process that recorded the key.
 *
 * A CLI invocation IS the restart, every time. So on that path the in-memory map
 * never survives to be read, `--idempotency-key` silently did nothing, and the
 * flag's own help — "retrying with the same key will not send twice" — was
 * false. That is worse than not offering the flag: a caller that trusts it stops
 * deduplicating for itself. Found by birddog, whose retry path is bounded
 * attempts under a stable key, so the inert flag turned its retry into the
 * duplicate-alert storm the key exists to prevent.
 *
 * Deliberately a SEPARATE class rather than making the shared store durable.
 * Persisting keys for hosted Tin Can too would strengthen a guarantee its
 * callers were told not to rely on, and would do it invisibly to every one of
 * them. The CLI is the path where durability is the only thing that makes the
 * documented behaviour true, so it is the only path that gets it.
 *
 * WHAT THIS GUARANTEES, precisely, because the neighbouring file is careful
 * about this and it would be easy to overclaim here:
 *
 *  - **Sequential retries are deduplicated**, across processes, within the
 *    window. That is the case the flag exists for and the case birddog has.
 *  - **Concurrent invocations are not.** Two processes starting together can
 *    both read no record and both send. Closing that needs a reservation taken
 *    BEFORE delivery, and a reservation is exactly what must not be taken: a
 *    crash or a transient failure between reserving and sending would burn the
 *    key, turning one flake into a permanent refusal. The existing store makes
 *    the same trade for the same reason — `record` is called only after a
 *    delivery succeeded — and a narrower race is not worth a worse failure.
 *  - **It is still not exactly-once** and must not be described as one. A key
 *    that ages out of the window and is reused will deliver again.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IDEMPOTENCY_WINDOW_MS, type PriorSend } from './idempotency.js';

/** Where the records live, beside `messages.jsonl` under the same root. */
export function cliIdempotencyDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.TINCAN_HOME ?? join(home, '.tincan'), 'send-keys');
}

export class FileIdempotencyStore {
  constructor(
    private readonly dir: string,
    private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Hashed, not used as a filename directly. A key is caller-supplied free text
   * — birddog's is `instance:incident:condition` — so it can contain a slash, a
   * `..`, or characters this filesystem will not take. Hashing makes every key a
   * fixed safe name and cannot collide in any way that matters at this size.
   */
  private pathFor(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /**
   * The prior send under this key, if one is still inside the window.
   *
   * Prunes on read, like the in-memory store: there is no daemon here to run a
   * timer, and without this the directory grows for the life of the machine.
   */
  lookup(key: string): PriorSend | undefined {
    this.prune();
    try {
      const raw = JSON.parse(readFileSync(this.pathFor(key), 'utf8')) as PriorSend;
      // A record at or past the cutoff is treated as absent rather than
      // deleted-then-absent: prune has already had its chance, and a key that
      // ages out must read as new.
      if (raw.at < this.now() - this.windowMs) return undefined;
      return raw;
    } catch {
      // Absent, unreadable, or truncated by a crash mid-write. All three mean
      // the same thing to a caller — no prior send is known — and none of them
      // is worth failing a send over. Treating a damaged record as "already
      // sent" would drop a real alert.
      return undefined;
    }
  }

  /** Recorded only after a delivery actually succeeded — see the class doc. */
  record(key: string, send: Omit<PriorSend, 'at'>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.pathFor(key), JSON.stringify({ ...send, at: this.now() }), 'utf8');
    } catch {
      /* A key we could not persist costs a duplicate on retry; a throw here
         would cost the caller a message that was already delivered. */
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as PriorSend;
        if (record.at < cutoff) unlinkSync(path);
      } catch {
        // Unparseable, or removed by a concurrent prune. Either way it is not a
        // record anyone can use; drop it if we can and never fail the send.
        try {
          unlinkSync(path);
        } catch {
          /* gone already, or not ours to remove */
        }
      }
    }
  }
}
