import { describe, it, expect } from 'vitest';
import { PLUGIN_VERSION, SESSION_ID_RE, MESSAGE_ID_RE } from '../tincan-lib/types.js';

describe('plugin constants', () => {
  it('exposes a semver plugin version', () => {
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches opencode session ids and rejects others', () => {
    expect(SESSION_ID_RE.test('ses_f4185535affe0nxzk66nw19ihJ')).toBe(true);
    expect(SESSION_ID_RE.test('sess_abc')).toBe(true);
    expect(SESSION_ID_RE.test('msg_abc')).toBe(false);
    expect(SESSION_ID_RE.test('')).toBe(false);
  });

  it('matches opencode message ids and rejects others', () => {
    expect(MESSAGE_ID_RE.test('msg_01J8TESTAAAAAAAAAAAAAAAA')).toBe(true);
    expect(MESSAGE_ID_RE.test('not-a-msg-id')).toBe(false);
  });
});
