import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageLog, messagesPath } from '../src/log.js';
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
