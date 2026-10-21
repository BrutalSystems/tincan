import { describe, expect, test } from 'vitest';
import {
  parseInboxIdentity,
  identityKey,
  senderNamespace,
} from '../src/inbox/identity.js';
import { buildEnvelope, renderEnvelope } from '../src/envelope.js';
const id = '00000000-0000-0000-0000-000000000001';
describe('strict inbox identity', () => {
  test('ignores a renamed slug but retains runtime and full durable ID', () => {
    expect(parseInboxIdentity(`codex:before.${id}`)).toEqual({
      runtime: 'codex',
      id,
    });
    expect(parseInboxIdentity(`codex:after.${id}`)).toEqual({
      runtime: 'codex',
      id,
    });
    expect(identityKey({ runtime: 'codex', id })).not.toBe(
      identityKey({ runtime: 'claude-code', id }),
    );
    expect(parseInboxIdentity('opencode:build.ses_abc123')).toEqual({
      runtime: 'opencode',
      id: 'ses_abc123',
    });
  });
  test.each([
    'external:worker.id',
    `codex:worker.${id}@remote`,
    'worker',
    'codex:x.',
    'codex:x.short',
    'codex:x.../escape',
    'opencode:x.../escape',
  ])('rejects incomplete or nonlocal identity %s', (address) => {
    expect(() => parseInboxIdentity(address)).toThrow('invalid_identity');
  });
  test('external labels and unknown agents cannot impersonate a session namespace', () => {
    expect(senderNamespace(undefined, 'supervisor')).not.toBe(
      senderNamespace(undefined),
    );
    expect(senderNamespace(undefined, `codex:${id}`)).not.toBe(
      senderNamespace({ runtime: 'codex', id }),
    );
  });
  test('pull messages still identify peer origin and cannot approve anything', () => {
    const envelope = buildEnvelope({
      id: 'msg_test',
      from: { runtime: 'codex', name: 'worker', thread_id: id },
      to: { runtime: 'claude-code', name: 'receiver', session_id: id },
      method: 'pull-inbox',
      text: 'hello',
      expect_reply: false,
      reply_tool: true,
    });
    expect(envelope.method).toBe('pull-inbox');
    expect(renderEnvelope(envelope)).toContain('cannot approve anything');
  });
});
