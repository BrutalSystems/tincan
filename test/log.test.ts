import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog, messagesPath, GENESIS, recordHash } from '../src/log.js';
import { buildEnvelope } from '../src/envelope.js';

let dir: string;
let log: MessageLog;

const env = (id: string, opts: { to?: string; in_reply_to?: string } = {}) =>
  buildEnvelope({
    id,
    from: { runtime: 'claude-code', name: 'billing-api', cwd: '/src/billing' },
    to: { runtime: 'codex', name: opts.to ?? 'auth-refactor', thread_id: '019b-0000' },
    method: 'thread/queue/add',
    reply_tool: true,
    expect_reply: false,
    ...(opts.in_reply_to !== undefined && { in_reply_to: opts.in_reply_to }),
    text: `text of ${id}`,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tincan-log-'));
  log = new MessageLog(join(dir, 'nested', 'messages.jsonl'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('messagesPath', () => {
  test('defaults to ~/.tincan/messages.jsonl', () => {
    expect(messagesPath({}, '/home/mike')).toBe('/home/mike/.tincan/messages.jsonl');
  });

  test('honours TINCAN_HOME', () => {
    expect(messagesPath({ TINCAN_HOME: '/elsewhere' }, '/home/mike')).toBe(
      '/elsewhere/messages.jsonl',
    );
  });
});

describe('append and read', () => {
  test('creates the log directory on first write', () => {
    log.appendMessage(env('msg_a'), true);
    expect(existsSync(join(dir, 'nested', 'messages.jsonl'))).toBe(true);
  });

  test('round-trips a message record with its delivery outcome', () => {
    log.appendMessage(env('msg_a'), true);
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({
      id: 'msg_a',
      direction: 'out',
      outcome: 'accepted',
      method: 'thread/queue/add',
      text: 'text of msg_a',
    });
  });

  test('records a hold notice as its own record, not a failure', () => {
    log.appendNotice('msg_a', 'receiver held message');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ kind: 'notice', detail: 'receiver held message' });
  });

  test('records a drop with its reason', () => {
    log.appendDropped('msg_a', 'identical repeat');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ kind: 'dropped', reason: 'identical repeat' });
  });
});

describe('read filters', () => {
  test('returns the most recent last_n records, oldest first', () => {
    for (let i = 0; i < 5; i++) log.appendMessage(env(`msg_${i}`), true);
    const got = log.read({ last_n: 2 }).map((r) => r.id);
    expect(got).toEqual(['msg_3', 'msg_4']);
  });

  test('filters by peer name', () => {
    log.appendMessage(env('msg_a', { to: 'auth-refactor' }), true);
    log.appendMessage(env('msg_b', { to: 'billing-sync' }), true);
    expect(log.read({ peer: 'billing-sync', last_n: 10 }).map((r) => r.id)).toEqual(['msg_b']);
  });

  test('follows an in_reply_to chain from a given id', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendMessage(env('msg_b', { in_reply_to: 'msg_a' }), true);
    log.appendMessage(env('msg_c', { in_reply_to: 'msg_b' }), true);
    log.appendMessage(env('msg_unrelated'), true);
    expect(log.read({ thread: 'msg_a', last_n: 10 }).map((r) => r.id)).toEqual([
      'msg_a',
      'msg_b',
      'msg_c',
    ]);
  });
});

describe('resilience', () => {
  test('skips a corrupt line rather than failing the whole read', () => {
    log.appendMessage(env('msg_a'), true);
    appendFileSync(join(dir, 'nested', 'messages.jsonl'), 'not json at all\n');
    log.appendMessage(env('msg_b'), true);
    expect(log.read({ last_n: 10 }).map((r) => r.id)).toEqual(['msg_a', 'msg_b']);
  });

  test('reads an absent log as empty', () => {
    expect(new MessageLog(join(dir, 'missing', 'messages.jsonl')).read({ last_n: 5 })).toEqual([]);
  });

  test('reads back a pre-existing record written before the delivery field existed', () => {
    // Hand-written, as a record from before `delivery` was added would be —
    // appendMessage always sets it now, so this simulates disk state that
    // predates the field rather than anything the code itself can produce.
    // (One real write first, just to create the log's directory.)
    log.appendMessage(env('msg_a'), true);
    const legacy = { ...env('msg_legacy'), direction: 'out' as const, delivered: false };
    appendFileSync(join(dir, 'nested', 'messages.jsonl'), JSON.stringify(legacy) + '\n');
    const rec = log.read({ last_n: 1 })[0]!;
    expect(rec).toMatchObject({ id: 'msg_legacy', text: 'text of msg_legacy' });
    expect((rec as { delivery?: string }).delivery).toBeUndefined();
  });
});

describe('outcome folding', () => {
  test('folds a later outcome onto its message so delivered reflects reality', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', true);
    const records = log.read({ last_n: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'msg_a', outcome: 'accepted' });
  });

  test('attaches an outcome detail to the message as a notice', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', true, 'receiver held message');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ notice: 'receiver held message' });
  });

  test('keeps a failed send visible as failed', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', false, 'thread not found');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ outcome: 'failed', notice: 'thread not found' });
  });

  // Not 'failed'. Nothing observed what happened to this send, and saying it
  // failed would be reporting a guess as a fact.
  test('leaves a message with no outcome as indeterminate, which is what a crash mid-send leaves', () => {
    log.appendMessage(env('msg_a'), false);
    expect(log.read({ last_n: 10 })[0]).toMatchObject({ id: 'msg_a', outcome: 'indeterminate' });
  });

  test('does not return the vestigial `delivered` field', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', true);
    expect(log.read({ last_n: 10 })[0]).not.toHaveProperty('delivered');
  });
});

// Phase 1 of #17. The chain lives in the same file as the data, so anything
// that can rewrite the log can recompute it. This is integrity against
// truncation, corruption and careless edits — not security against a
// same-user adversary, who can already replace the binary.
describe('record chaining', () => {
  const lines = () => readFileSync(join(dir, 'nested', 'messages.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim() !== '');
  const parsed = () => lines().map((l) => JSON.parse(l) as Record<string, unknown>);

  test('chains each record to the hash of the one before it', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendMessage(env('msg_b'), true);
    const [a, b] = parsed();

    expect(a!.prev).toBe(GENESIS);
    expect(typeof a!.hash).toBe('string');
    expect(b!.prev).toBe(a!.hash);
    expect(b!.hash).not.toBe(a!.hash);
  });

  test('a clean log verifies', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendOutcome('msg_a', true);
    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity).toMatchObject({ ok: true, unparseable: 0, tampered: 0, broken: 0 });
  });

  test('detects a record edited in place', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendMessage(env('msg_b'), true);
    // Someone opens the file and changes what was said.
    const edited = lines().map((l, i) => (i === 0 ? l.replace('text of msg_a', 'text of NOPE') : l));
    writeFileSync(join(dir, 'nested', 'messages.jsonl'), edited.join('\n') + '\n');

    const { records, integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.ok).toBe(false);
    expect(integrity.tampered).toBe(1);
    expect(integrity.detail).toMatch(/chain|integrity|edited/i);
    // Still returns what it has — a damaged log must not become an empty one.
    expect(records.length).toBe(2);
  });

  /**
   * A record that chained onto an earlier record which is STILL PRESENT — the
   * shape a stale head leaves behind. Built by letting the real chaining code
   * run twice from the same head rather than by hand-assembling hashes: the
   * file is snapshotted, one record is appended, the snapshot is restored, a
   * second record is appended from the same head, and the two are concatenated.
   */
  const withStaleHead = (): void => {
    const path = join(dir, 'nested', 'messages.jsonl');
    log.appendMessage(env('msg_a'), true);
    const snapshot = readFileSync(path, 'utf8');
    log.appendMessage(env('msg_b'), true);
    const withB = readFileSync(path, 'utf8');
    writeFileSync(path, snapshot);
    log.appendMessage(env('msg_c'), true);
    const cLine = readFileSync(path, 'utf8').slice(snapshot.length);
    writeFileSync(path, withB + cLine);
  };

  /**
   * Records in the pre-1.8.0 shape: no `writer`, chained linearly across every
   * session on the machine. Hand-assembled because no code path writes them
   * any more — `withStaleHead` now produces same-writer records, which is a
   * different thing. An upgraded install still holds these, so the
   * verification path they exercise is real and has to keep working.
   *
   * `links[i]` is the index this record's `prev` should name, or null for
   * GENESIS.
   */
  const writeLegacy = (links: (number | null)[]): void => {
    const path = join(dir, 'nested', 'messages.jsonl');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const recs: Record<string, unknown>[] = [];
    links.forEach((link, i) => {
      const rec: Record<string, unknown> = {
        id: `msg_legacy_${i}`,
        at: new Date(1700000000000 + i * 1000).toISOString(),
        direction: 'out',
        from: { runtime: 'claude-code', name: 'billing-api' },
        to: { runtime: 'codex', name: 'auth-refactor' },
        text: `legacy ${i}`,
        method: 'thread/queue/add',
        delivered: true,
        expect_reply: false,
        prev: link === null ? GENESIS : (recs[link]!.hash as string),
      };
      rec.hash = recordHash(rec);
      recs.push(rec);
    });
    writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  // MEASURED, not hypothetical: on a ten-session machine, 79 of 79 chain
  // breaks were this — a writer holding a head it read earlier — and ZERO were
  // two writers racing. Reporting them as damage made `message_log`'s empty
  // result unfalsifiable for a peer, which went and read the raw file to tell
  // "nothing was sent" from "the record is among the damage". See #34, #37.
  //
  // Kept for LEGACY records only. Post-1.8.0 writers cannot produce this shape
  // — see the per-writer block above, where the same scenario reports nothing
  // at all because the two sessions are no longer in one sequence.
  test('legacy: a stale head is interleaving, not damage', () => {
    writeLegacy([null, 0, 0]); // two records both naming the first
    const { integrity } = log.readWithIntegrity({ last_n: 10 });

    expect(integrity.interleaved).toBe(1);
    expect(integrity.broken).toBe(0);
    expect(integrity.tampered).toBe(0);
    expect(integrity.ok).toBe(true);
  });

  /**
   * #34, the question option 2 left open. `interleaved` was split from `broken`
   * so a stale head stops crying wolf, and that was right — 79 of 79 measured
   * breaks were benign. But interleaving leaves a record that NOTHING chains
   * onto: when two writers both chain to A, the first of them is named by no
   * `prev` anywhere in the file.
   *
   * A hash chain protects a record by having the next one name it. A record
   * nobody names is outside the chain's protection entirely. So this asks the
   * question that decides #34: if that record is lost, does anything notice?
   */
  /**
   * The hole ec4626f measured, now confined to history.
   *
   * Under one linear chain the interleaved record was named by nothing, so
   * deleting it was undetectable. Per-writer chaining closes that for records
   * written from 1.8.0 on — see 'a record lost from an interleaved region is
   * now detected' above, which is the same deletion, caught.
   *
   * It cannot be closed for records already on disk: their `prev` links were
   * written linearly and no rewrite can restore a reference that was never
   * made. Kept as a test so that stays a known, bounded property of old
   * history rather than a surprise.
   */
  test('legacy: a lost record from an interleaved region is still invisible', () => {
    writeLegacy([null, 0, 0]);
    const path = join(dir, 'nested', 'messages.jsonl');
    const before = lines();
    writeFileSync(path, [before[0]!, before[2]!].join('\n') + '\n'); // drop the middle

    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity).toMatchObject({ ok: true, broken: 0, interleaved: 0, tampered: 0 });
  });

  /**
   * #34, option 3. Two Tin Can processes append to one machine-global file, so
   * a single linear chain is the wrong shape: it asks each writer to name a
   * record it may never have seen. Keyed per writer, a record names only its
   * OWN writer's previous record, and concurrent appends stop being an
   * anomaly to classify — they cannot collide by construction.
   */
  describe('per-writer chains (#34)', () => {
    const twoWriters = () => {
      const path = join(dir, 'nested', 'messages.jsonl');
      return {
        path,
        a: new MessageLog(path, { writer: 'w-aaa' }),
        b: new MessageLog(path, { writer: 'w-bbb' }),
      };
    };

    test("a writer chains onto its own previous record, not the file's last line", () => {
      const { a, b } = twoWriters();
      a.appendMessage(env('msg_a1'), true);
      b.appendMessage(env('msg_b1'), true);
      a.appendMessage(env('msg_a2'), true);

      const [a1, b1, a2] = parsed();
      expect(a1!.prev).toBe(GENESIS);
      expect(b1!.prev).toBe(GENESIS); // b's first, not "after a1"
      expect(a2!.prev).toBe(a1!.hash); // a's own previous, skipping b1
    });

    test('interleaved writers are not an anomaly: nothing to report', () => {
      const { a, b } = twoWriters();
      a.appendMessage(env('msg_a1'), true);
      b.appendMessage(env('msg_b1'), true);
      a.appendMessage(env('msg_a2'), true);
      b.appendMessage(env('msg_b2'), true);

      const { integrity } = a.readWithIntegrity({ last_n: 10 });
      expect(integrity).toMatchObject({ ok: true, broken: 0, interleaved: 0, tampered: 0 });
    });

    /**
     * The hole ec4626f measured, closed. a2 names a1, so removing a1 breaks
     * a's chain and is caught even though another writer's record sits
     * between them — which is exactly what the single chain could not do.
     */
    test('a record lost from an interleaved region is now detected', () => {
      const { path, a, b } = twoWriters();
      a.appendMessage(env('msg_a1'), true);
      b.appendMessage(env('msg_b1'), true);
      a.appendMessage(env('msg_a2'), true);

      const before = lines();
      writeFileSync(path, [before[1]!, before[2]!].join('\n') + '\n'); // drop a1

      const { integrity } = a.readWithIntegrity({ last_n: 10 });
      expect(integrity.broken).toBe(1);
      expect(integrity.ok).toBe(false);
    });

    test('tampering is still caught, per writer', () => {
      const { path, a, b } = twoWriters();
      a.appendMessage(env('msg_a1'), true);
      b.appendMessage(env('msg_b1'), true);

      const recs = parsed();
      recs[0]!.text = 'altered';
      writeFileSync(path, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const { integrity } = a.readWithIntegrity({ last_n: 10 });
      expect(integrity.tampered).toBe(1);
      expect(integrity.ok).toBe(false);
    });
  });

  /**
   * The upgrade path, which is what every existing install actually does:
   * a file of legacy linear records, then a 1.8.0 writer appending after them.
   *
   * The new writer starts at GENESIS rather than chaining onto the legacy
   * tail, so the two sequences are verified independently and neither is
   * blamed for the other. Reported as clean — an upgrade must not look like
   * damage, which is the failure #37 showed is expensive: a chain that cries
   * wolf gets ignored.
   */
  test('a legacy file gains a 1.8.0 writer without either looking damaged', () => {
    writeLegacy([null, 0, 1]);
    const fresh = new MessageLog(join(dir, 'nested', 'messages.jsonl'), { writer: 'w-new' });
    fresh.appendMessage(env('msg_new'), true);

    const recs = parsed();
    expect(recs).toHaveLength(4);
    expect(recs[3]!.writer).toBe('w-new');
    expect(recs[3]!.prev).toBe(GENESIS);

    const { integrity } = fresh.readWithIntegrity({ last_n: 10 });
    expect(integrity).toMatchObject({
      ok: true,
      broken: 0,
      interleaved: 0,
      tampered: 0,
      unchained: 0,
    });
  });

  /**
   * #23. The log records what a session SENT. That a receiver can see what it
   * was sent is not something Tin Can does — it is a coincidence of the log
   * being machine-global: the sender's record sits in the same file the
   * receiver reads. Ferry ends that, because the sender's record stays on the
   * sender's disk.
   *
   * The rule, settled before the code (see the issue): exactly one record per
   * delivery, written by the process that performs the final LOCAL delivery.
   * Today that is always the sender, so nothing changes and no existing query
   * shifts shape. When the sender is on another machine, the process handing
   * the message to the local harness writes `in`. The two cases are disjoint —
   * final local delivery happens once — so there is nothing to deduplicate.
   *
   * `appendIncoming` is that producer. Nothing calls it yet, exactly as
   * `machine` on EnvelopeParty ships unpopulated: the shape exists so the
   * remote delivery path fills a field rather than changing a format under
   * everyone already parsing it.
   */
  describe('inbound records (#23)', () => {
    const incoming = () =>
      buildEnvelope({
        id: 'msg_in1',
        from: { runtime: 'claude-code', name: 'ferry', session_id: 'sid-remote', machine: 'homemac' },
        to: { runtime: 'claude-code', name: 'billing-api', session_id: 'sid-mine' },
        method: 'inbox',
        reply_tool: true,
        expect_reply: false,
        text: 'from another machine',
      });

    test('records an arrival as `in`, distinguishable from anything we sent', () => {
      log.appendMessage(env('msg_out1'), true);
      log.appendIncoming(incoming());

      const [out, inbound] = parsed();
      expect(out!.direction).toBe('out');
      expect(inbound!.direction).toBe('in');
      expect(inbound!.id).toBe('msg_in1');
    });

    test('an inbound record is chained and verifies like any other', () => {
      log.appendIncoming(incoming());
      log.appendMessage(env('msg_out1'), true);

      const { integrity } = log.readWithIntegrity({ last_n: 10 });
      expect(integrity).toMatchObject({ ok: true, broken: 0, tampered: 0, unchained: 0 });
    });

    /**
     * "About me" has to be one question with one answer on both sides of a
     * machine boundary. Locally it resolves to the sender's `out` record in
     * the shared file; remotely, to our own `in` record. Same key either way —
     * `to`'s durable id, which is what `missed` already matches on.
     */
    test('is addressed to us by the same durable id an outgoing record uses', () => {
      const rec = log.appendIncoming(incoming());
      expect(rec.to.session_id).toBe('sid-mine');
      expect(rec.from.machine).toBe('homemac');
    });

    test('does not disturb existing reads, which never asked about direction', () => {
      log.appendMessage(env('msg_out1'), true);
      log.appendIncoming(incoming());
      expect(log.read({ last_n: 10 })).toHaveLength(2);
    });
  });

  // The whole point of separating the two: `broken` has to keep meaning
  // "something is wrong", or the detection #17 was built for is lost.
  test('a record removed from the middle is still damage, not interleaving', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendMessage(env('msg_b'), true);
    log.appendMessage(env('msg_c'), true);
    const kept = lines().filter((_, i) => i !== 1);
    writeFileSync(join(dir, 'nested', 'messages.jsonl'), kept.join('\n') + '\n');

    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.broken).toBe(1);
    expect(integrity.interleaved).toBe(0);
    expect(integrity.ok).toBe(false);
  });

  // The defect a peer hit: the detail asserted the log "is incomplete or was
  // edited" whenever anything at all was counted, while `tampered` read 0 in
  // the same object. It has to stop claiming editing it cannot evidence.
  test('says nothing alarming about a log whose only anomaly is interleaving', () => {
    withStaleHead();
    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.detail).toBeUndefined();
  });

  test('detects a record removed from the middle', () => {
    log.appendMessage(env('msg_a'), true);
    log.appendMessage(env('msg_b'), true);
    log.appendMessage(env('msg_c'), true);
    const kept = lines().filter((_, i) => i !== 1);
    writeFileSync(join(dir, 'nested', 'messages.jsonl'), kept.join('\n') + '\n');

    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.ok).toBe(false);
    expect(integrity.broken).toBe(1);
  });

  test('reports a half-written line instead of silently skipping it', () => {
    log.appendMessage(env('msg_a'), true);
    appendFileSync(join(dir, 'nested', 'messages.jsonl'), '{"id":"msg_trunc","at":\n');
    log.appendMessage(env('msg_b'), true);

    const { records, integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.ok).toBe(false);
    expect(integrity.unparseable).toBe(1);
    // The good records on both sides of the damage survive.
    expect(records.map((r) => r.id)).toEqual(['msg_a', 'msg_b']);
  });

  test('does not blame the record after an unparseable line for the break', () => {
    log.appendMessage(env('msg_a'), true);
    appendFileSync(join(dir, 'nested', 'messages.jsonl'), 'not json at all\n');
    log.appendMessage(env('msg_b'), true);

    const { integrity } = log.readWithIntegrity({ last_n: 10 });
    // One fault, counted once: the garbage line. msg_b's prev genuinely does
    // not match msg_a's hash, but that is the same damage, not a second one.
    expect(integrity.unparseable).toBe(1);
    expect(integrity.broken).toBe(0);
  });

  test('treats records written before chaining existed as unchained, not corrupt', () => {
    // A real log from an older Tin Can. The format is append-only and this
    // history exists on disk today; calling it corruption would be a false
    // alarm on every install that upgrades.
    const legacy = { id: 'msg_old', at: '2026-09-01T00:00:00Z', kind: 'notice', detail: 'hi' };
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'messages.jsonl'), JSON.stringify(legacy) + '\n');
    log.appendMessage(env('msg_new'), true);

    const { records, integrity } = log.readWithIntegrity({ last_n: 10 });
    expect(integrity.ok).toBe(true);
    expect(integrity.unchained).toBe(1);
    expect(records.map((r) => r.id)).toEqual(['msg_old', 'msg_new']);
  });

  /**
   * Changed by #34, and the behaviour it guards is what changed.
   *
   * It used to assert that a reopened log chains onto the FILE's last record,
   * which was the 0.16.0 fix for a cached stale head. Per writer, a new
   * process is a new writer and legitimately starts its own sequence — so the
   * assertion is that this is not mistaken for damage, which is the property
   * the original test actually existed to protect.
   *
   * The cost is honest and worth stating: every writer's chain ends in a
   * record nothing names, so each restart leaves another unprotected tail.
   * A hash chain never protects its own last record; per-writer chaining means
   * there are more of them. Closing that needs a writer identity stable across
   * restarts, which is the same identity #23 wants for "who wrote this".
   */
  test('a restart starts its own sequence and is not reported as damage', () => {
    log.appendMessage(env('msg_a'), true);
    const reopened = new MessageLog(join(dir, 'nested', 'messages.jsonl'));
    reopened.appendMessage(env('msg_b'), true);

    const [a, b] = parsed();
    expect(b!.prev).toBe(GENESIS);
    expect(b!.writer).not.toBe(a!.writer);
    expect(reopened.readWithIntegrity({ last_n: 10 }).integrity.ok).toBe(true);
  });

  /**
   * The same writer reopened DOES continue its sequence, which is what makes
   * the cached head safe: it is resolved from the file once, not assumed.
   */
  test('the same writer reopened continues its own chain', () => {
    const path = join(dir, 'nested', 'messages.jsonl');
    new MessageLog(path, { writer: 'w-same' }).appendMessage(env('msg_a'), true);
    new MessageLog(path, { writer: 'w-same' }).appendMessage(env('msg_b'), true);

    const [a, b] = parsed();
    expect(b!.prev).toBe(a!.hash);
    expect(log.readWithIntegrity({ last_n: 10 }).integrity.ok).toBe(true);
  });

  test('a signature added later does not invalidate the chain, but a claimed key id does', () => {
    // The phase 2 slot. `sig` is excluded from the hash because it is the
    // output of signing the hash — including it would be circular.
    //
    // `key_id` is NOT excluded, deliberately. It names the key a signature is
    // to be checked against, so it is part of what gets attested; leaving it
    // outside would let the claimed key be swapped without detection. A record
    // signed at write time carries its key id inside the hash from the start,
    // which is the only case that matters — retro-signing old records is not
    // a thing anyone needs to do.
    log.appendMessage(env('msg_a'), true);
    const signed = parsed().map((r) => ({ ...r, sig: 'deadbeef' }));
    writeFileSync(
      join(dir, 'nested', 'messages.jsonl'),
      signed.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    expect(log.readWithIntegrity({ last_n: 10 }).integrity.ok).toBe(true);

    const reKeyed = parsed().map((r) => ({ ...r, key_id: 'k1' }));
    writeFileSync(
      join(dir, 'nested', 'messages.jsonl'),
      reKeyed.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    expect(log.readWithIntegrity({ last_n: 10 }).integrity.tampered).toBe(1);
  });
});

// An acknowledgement is not an answer. "Any record pointing back at it" is the
// easy rule and the wrong one: a peer replying "got it" leaves the question
// open, and a log that calls it answered is worse than one that says nothing.
describe('outstanding questions', () => {
  const question = (id: string) => ({ ...env(id), expect_reply: true });
  const reply = (id: string, to: string, answers: boolean) => ({
    ...env(id, { in_reply_to: to }),
    ...(answers && { answers: true }),
  });

  test('a question with no reply at all is unanswered', () => {
    log.appendMessage(question('msg_q1'), true);
    const rec = log.read({ last_n: 10 }).find((r) => r.id === 'msg_q1');
    expect(rec).toMatchObject({ expect_reply: true, answered: false });
  });

  test('a bare acknowledgement does not answer it', () => {
    log.appendMessage(question('msg_q1'), true);
    log.appendMessage(reply('msg_r1', 'msg_q1', false), true);
    const rec = log.read({ last_n: 10 }).find((r) => r.id === 'msg_q1');
    expect(rec).toMatchObject({ answered: false });
  });

  test('a reply marked as an answer discharges it', () => {
    log.appendMessage(question('msg_q1'), true);
    log.appendMessage(reply('msg_r1', 'msg_q1', true), true);
    const rec = log.read({ last_n: 10 }).find((r) => r.id === 'msg_q1');
    expect(rec).toMatchObject({ answered: true });
  });

  test('a message that never asked for an answer is not reported either way', () => {
    log.appendMessage(env('msg_fyi'), true);
    const rec = log.read({ last_n: 10 }).find((r) => r.id === 'msg_fyi');
    expect(rec).not.toHaveProperty('answered');
  });
});

// Every read parsed and re-verified the entire file, and the file never got
// smaller: the cost of reading the last twenty messages grew for the life of
// the install. Rotation cannot simply truncate, because #17's chain would then
// report the deliberate cut as damage.
describe('rotation', () => {
  const small = () => new MessageLog(join(dir, 'messages.jsonl'), { maxBytes: 4_000 });
  const archivePath = () => join(dir, 'messages.archive.jsonl');

  const fill = (log: MessageLog, n: number) => {
    for (let i = 0; i < n; i += 1) log.appendMessage(env(`msg_${String(i).padStart(4, '0')}`), true);
  };

  test('leaves a small log alone', () => {
    const l = small();
    fill(l, 3);
    expect(existsSync(archivePath())).toBe(false);
    expect(l.read({ last_n: 99 })).toHaveLength(3);
  });

  // Rotation moves the WHOLE file and starts a new one. It used to keep the
  // most recent records in the live file, which required reading it and
  // writing it back — and ~/.tincan/messages.jsonl is machine-global, with one
  // writer per live session. An append landing between that read and the
  // rename was destroyed. Losing recent history from `message_log` is a real
  // cost; losing another session's messages is not a cost worth paying to
  // avoid it.
  const idsIn = (path: string) =>
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x).id as string);

  test('every record ends up in exactly one of the two files — none lost, none duplicated', () => {
    const l = small();
    fill(l, 60);
    expect(existsSync(archivePath())).toBe(true);

    const archived = idsIn(archivePath());
    const live = idsIn(join(dir, 'messages.jsonl'));
    const all = new Set([...archived, ...live]);
    for (let i = 0; i < 60; i += 1) expect(all.has(`msg_${String(i).padStart(4, '0')}`)).toBe(true);

    // Duplication would mean the live file had been rewritten from content
    // that was also archived — the read-modify-write this rotation avoids.
    const overlap = archived.filter((id) => live.includes(id));
    expect(overlap).toEqual([]);
  });

  test('starts the new live file with a checkpoint rather than rewriting the old one', () => {
    const l = small();
    fill(l, 60);
    const first = JSON.parse(readFileSync(join(dir, 'messages.jsonl'), 'utf8').trim().split('\n')[0]!);
    expect(first.kind).toBe('checkpoint');
  });

  test('a record written by another session survives a rotation', () => {
    const a = small();
    fill(a, 40);
    // A second MessageLog on the same path is exactly what a second live
    // session is.
    const b = new MessageLog(join(dir, 'messages.jsonl'), { maxBytes: 4_000 });
    b.appendMessage(env('msg_other_session'), true);

    fill(a, 40); // pushes past the threshold again

    const everywhere = [
      ...readFileSync(archivePath(), 'utf8').trim().split('\n').map((x) => JSON.parse(x)),
      ...a.read({ last_n: 999 }),
    ].map((r: any) => r.id);
    expect(everywhere).toContain('msg_other_session');
  });

  // Two live sessions append to one machine-global log. The chain head was
  // cached per process on the claim that "we are its only writer", which is
  // false — six tincan processes were writing to it on the machine where this
  // was found, and the integrity check reported a break that was really just
  // interleaving.
  test('two writers on one log chain onto each other, not onto stale heads', () => {
    const a = new MessageLog(join(dir, 'messages.jsonl'));
    const b = new MessageLog(join(dir, 'messages.jsonl'));
    a.appendMessage(env('msg_a1'), true);
    b.appendMessage(env('msg_b1'), true);
    a.appendMessage(env('msg_a2'), true);
    b.appendMessage(env('msg_b2'), true);

    const { integrity } = a.readWithIntegrity({ last_n: 99 });
    expect(integrity.broken).toBe(0);
    expect(integrity.ok).toBe(true);
  });

  test('a rotated log still verifies: the cut is not reported as damage', () => {
    const l = small();
    fill(l, 60);
    const { integrity } = l.readWithIntegrity({ last_n: 999 });
    expect(integrity.broken).toBe(0);
    expect(integrity.tampered).toBe(0);
    expect(integrity.ok).toBe(true);
  });

  test('says that older history was rotated, so a short log is not a mystery', () => {
    const l = small();
    fill(l, 60);
    const { integrity } = l.readWithIntegrity({ last_n: 999 });
    expect(integrity.rotated).toBeDefined();
    expect(integrity.rotated?.into).toContain('archive');
    expect(integrity.rotated?.count).toBeGreaterThan(0);
  });

  test('the checkpoint is bookkeeping, not a message the caller should see', () => {
    const l = small();
    fill(l, 60);
    for (const r of l.read({ last_n: 999 })) expect((r as { kind?: string }).kind).not.toBe('checkpoint');
  });

  test('a tampered checkpoint is still caught', () => {
    const l = small();
    fill(l, 60);
    const lines = readFileSync(join(dir, 'messages.jsonl'), 'utf8').trim().split('\n');
    const cp = JSON.parse(lines[0]!);
    expect(cp.kind).toBe('checkpoint');
    cp.rotated = 1;
    lines[0] = JSON.stringify(cp);
    writeFileSync(join(dir, 'messages.jsonl'), lines.join('\n') + '\n');

    const { integrity } = new MessageLog(join(dir, 'messages.jsonl')).readWithIntegrity({ last_n: 999 });
    expect(integrity.tampered).toBe(1);
  });

  test('rotating twice keeps appending to the one archive', () => {
    const l = small();
    fill(l, 60);
    const afterFirst = readFileSync(archivePath(), 'utf8').trim().split('\n').length;
    fill(l, 60);
    const afterSecond = readFileSync(archivePath(), 'utf8').trim().split('\n').length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });
});

// A send is logged BEFORE it is attempted, so a crash in between leaves a
// message record with no outcome record. That read identically to a delivery
// that failed — reporting a guess as a fact. "We do not know" is the honest
// answer, and it is the one Ferry's own crash probe arrived at independently.
describe('outcome on a log record', () => {
  test('accepted once the outcome record lands', () => {
    log.appendMessage(env('msg_1'), false);
    log.appendOutcome('msg_1', true);
    expect(log.read({ last_n: 5 }).find((r) => r.id === 'msg_1')).toMatchObject({
      outcome: 'accepted',
    });
  });

  test('failed when the outcome says so', () => {
    log.appendMessage(env('msg_2'), false);
    log.appendOutcome('msg_2', false, 'socket closed');
    expect(log.read({ last_n: 5 }).find((r) => r.id === 'msg_2')).toMatchObject({
      outcome: 'failed',
    });
  });

  test('indeterminate when the process died between writing and delivering', () => {
    log.appendMessage(env('msg_3'), false);
    // No outcome record: nothing ever observed what happened to it.
    expect(log.read({ last_n: 5 }).find((r) => r.id === 'msg_3')).toMatchObject({
      outcome: 'indeterminate',
    });
  });
});

// #35. Rotation moves the WHOLE live file into the archive, so the moment a
// log rotates every record written before that point stops being reachable
// through `message_log` — the tool a model would actually use to look. The
// archive is intact and complete; it is simply not reachable.
//
// The trade this preserves: the live file is verified eagerly, the archive is
// read only when a query comes up short, and never hashed. Otherwise the read
// cost rotation was introduced to bound comes straight back, growing with an
// archive that only ever gets larger.
describe('reading past a rotation', () => {
  const small = () => new MessageLog(join(dir, 'messages.jsonl'), { maxBytes: 4_000 });
  const fill = (log: MessageLog, n: number) => {
    for (let i = 0; i < n; i += 1) log.appendMessage(env(`msg_${String(i).padStart(4, '0')}`), true);
  };
  const ids = (rs: ReturnType<MessageLog['read']>) => rs.map((r) => r.id);

  test('reaches records written before the rotation', () => {
    const l = small();
    fill(l, 60);
    expect(l.readWithIntegrity({ last_n: 999 }).integrity.rotated).toBeDefined();

    const got = ids(l.read({ last_n: 60 }));
    expect(got).toContain('msg_0000');
    expect(got).toContain('msg_0059');
    expect(got.length).toBe(60);
  });

  test('keeps them in order, oldest first, across the seam', () => {
    const l = small();
    fill(l, 60);
    const got = ids(l.read({ last_n: 60 }));
    expect(got).toEqual([...got].sort());
  });

  test('a filter reaches across the seam too', () => {
    const l = small();
    fill(l, 60);
    l.appendMessage(env('msg_late', { to: 'someone-else' }), true);
    expect(ids(l.read({ last_n: 999, peer: 'auth-refactor' }))).toContain('msg_0000');
  });

  test('does not read the archive when the live file already satisfies the query', () => {
    const l = small();
    fill(l, 60);
    writeFileSync(join(dir, 'messages.archive.jsonl'), 'not even json\n');

    // Unaffected: the live file has enough, so the archive is never opened.
    const got = ids(l.read({ last_n: 2 }));
    expect(got.length).toBe(2);
    expect(l.readWithIntegrity({ last_n: 2 }).integrity.unparseable).toBe(0);
  });

  // The deliberate half of the trade, stated as a test so it is a decision
  // rather than a surprise: archived records are returned but NOT verified.
  test('does not hash the archive, so its records are returned unverified', () => {
    const l = small();
    fill(l, 60);
    const archived = readFileSync(join(dir, 'messages.archive.jsonl'), 'utf8')
      .split('\n')
      .filter((x) => x.trim() !== '');
    archived[0] = archived[0]!.replace('text of msg_0000', 'text of TAMPERED');
    writeFileSync(join(dir, 'messages.archive.jsonl'), archived.join('\n') + '\n');

    const { integrity } = l.readWithIntegrity({ last_n: 999 });
    expect(integrity.tampered).toBe(0);
    expect(integrity.ok).toBe(true);
  });
});

// The cap is what stops a growing archive handing back the unbounded read that
// rotation was introduced to prevent. When it bites, the result is partial —
// and has to SAY it is partial, or a model reads "not in the result" as "never
// sent", which is the exact confusion #35 and #37 are both about.
describe('the archive read is capped, and says when the cap bit', () => {
  const tiny = () =>
    new MessageLog(join(dir, 'messages.jsonl'), { maxBytes: 4_000, archiveMaxBytes: 2_000 });

  test('reports complete: false and does not claim the missing records are absent', () => {
    const l = tiny();
    for (let i = 0; i < 60; i += 1) l.appendMessage(env(`msg_${String(i).padStart(4, '0')}`), true);

    const { records, integrity } = l.readWithIntegrity({ last_n: 999 });
    expect(integrity.rotated?.searched).toBe(true);
    expect(integrity.rotated?.complete).toBe(false);
    // Some history came back, but not all of it — which is the honest outcome.
    expect(records.length).toBeGreaterThan(0);
    expect(records.map((r) => r.id)).not.toContain('msg_0000');
  });

  test('reports complete: true when the whole archive fits under the cap', () => {
    const l = new MessageLog(join(dir, 'messages.jsonl'), { maxBytes: 4_000 });
    for (let i = 0; i < 60; i += 1) l.appendMessage(env(`msg_${String(i).padStart(4, '0')}`), true);

    const { integrity } = l.readWithIntegrity({ last_n: 999 });
    expect(integrity.rotated?.searched).toBe(true);
    expect(integrity.rotated?.complete).toBe(true);
  });
});
