import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog, messagesPath, GENESIS } from '../src/log.js';
import { buildEnvelope } from '../src/envelope.js';

let dir: string;
let log: MessageLog;

const env = (id: string, opts: { to?: string; in_reply_to?: string } = {}) =>
  buildEnvelope({
    id,
    from: { runtime: 'claude-code', name: 'billing-api', cwd: '/src/billing' },
    to: { runtime: 'codex', name: opts.to ?? 'auth-refactor', thread_id: '019b-0000' },
    method: 'codex-queue',
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
      delivered: true,
      method: 'codex-queue',
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
    expect(records[0]).toMatchObject({ id: 'msg_a', delivered: true });
  });

  test('attaches an outcome detail to the message as a notice', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', true, 'receiver held message');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ notice: 'receiver held message' });
  });

  test('keeps a failed send visible as undelivered', () => {
    log.appendMessage(env('msg_a'), false);
    log.appendOutcome('msg_a', false, 'thread not found');
    const [rec] = log.read({ last_n: 10 });
    expect(rec).toMatchObject({ delivered: false, notice: 'thread not found' });
  });

  test('leaves a message with no outcome undelivered, as a crash mid-send would', () => {
    log.appendMessage(env('msg_a'), false);
    expect(log.read({ last_n: 10 })[0]).toMatchObject({ id: 'msg_a', delivered: false });
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

  test('continues the chain across a restart, reading the head off disk', () => {
    log.appendMessage(env('msg_a'), true);
    const reopened = new MessageLog(join(dir, 'nested', 'messages.jsonl'));
    reopened.appendMessage(env('msg_b'), true);

    const [a, b] = parsed();
    expect(b!.prev).toBe(a!.hash);
    expect(reopened.readWithIntegrity({ last_n: 10 }).integrity.ok).toBe(true);
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
