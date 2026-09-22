import { describe, test, expect } from 'vitest';
import { IdempotencyStore, IDEMPOTENCY_WINDOW_MS } from '../src/idempotency.js';

const send = (over: Partial<Parameters<IdempotencyStore['record']>[1]> = {}) => ({
  messageId: 'msg_abc',
  peer: 'auth-refactor',
  peerArg: 'auth-refactor',
  text: 'rebase onto main',
  ...over,
});

describe('IdempotencyStore', () => {
  test('remembers a key inside the window', () => {
    let t = 1_000;
    const store = new IdempotencyStore(IDEMPOTENCY_WINDOW_MS, () => t);
    store.record('k', send());

    t += IDEMPOTENCY_WINDOW_MS - 1;
    expect(store.lookup('k')?.messageId).toBe('msg_abc');
  });

  test('forgets a key once the window has passed', () => {
    let t = 1_000;
    const store = new IdempotencyStore(IDEMPOTENCY_WINDOW_MS, () => t);
    store.record('k', send());

    t += IDEMPOTENCY_WINDOW_MS + 1;
    expect(store.lookup('k')).toBeUndefined();
  });

  test('an unrelated key is not remembered', () => {
    const store = new IdempotencyStore();
    store.record('k', send());
    expect(store.lookup('other')).toBeUndefined();
  });

  // There is no background timer, so eviction rides on the read path. If it
  // did not, a long-lived session would accumulate a key per send forever.
  test('pruning evicts every expired key, not only the one being looked up', () => {
    let t = 1_000;
    const store = new IdempotencyStore(IDEMPOTENCY_WINDOW_MS, () => t);
    for (let i = 0; i < 50; i += 1) store.record(`k${i}`, send({ messageId: `msg_${i}` }));

    t += IDEMPOTENCY_WINDOW_MS + 1;
    store.lookup('anything');

    const internal = store as unknown as { seen: Map<string, unknown> };
    expect(internal.seen.size).toBe(0);
  });
});
