import { describe, test, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { messagesPath } from '../src/log.js';
import { pointerDir } from '../src/claude/registry.js';

/**
 * A guard on the test environment itself, not on any behaviour.
 *
 * With `TINCAN_HOME` unset, `pointerDir` falls back to `~/.tincan`
 * (`src/claude/registry.ts:26`) — and the registry does not only read it:
 * `unlinkSync(recordPath(dir, sessionId))` removes a pointer record, and
 * `messagesPath` appends to `~/.tincan/messages.jsonl`. So a test that builds a
 * side or a MessageLog without passing an explicit home writes to, and can
 * delete from, the real one. Deleting a live session's pointer makes that peer
 * report `can_reply: false` and unrepliable until it registers again — on the
 * machine of whoever ran `npm test`, while they were using it.
 *
 * Every seam today is opt-in per test. That works until one test forgets, and
 * the failure is silent: the suite passes. These assertions make the protection
 * a property of the run rather than a thing each test remembers.
 */
describe('test environment isolation', () => {
  test('TINCAN_HOME is set, so nothing can fall back to the real ~/.tincan', () => {
    expect(process.env.TINCAN_HOME).toBeTruthy();
  });

  test('TINCAN_HOME is not the real one', () => {
    expect(process.env.TINCAN_HOME).not.toBe(join(homedir(), '.tincan'));
    expect(process.env.TINCAN_HOME?.startsWith(homedir())).toBe(false);
  });

  /**
   * The env var is only a proxy. These two call the real production helpers with
   * no explicit home, which is exactly what a test that forgets its seam does,
   * and assert the answer is not the path that holds live records.
   *
   * `pointerDir` is the one that deletes: `unlinkSync(recordPath(dir,
   * sessionId))`. `messagesPath` is the one that appends.
   */
  test('the production default for the message log is not the real one', () => {
    expect(messagesPath(process.env)).not.toBe(join(homedir(), '.tincan', 'messages.jsonl'));
    expect(messagesPath(process.env).startsWith(homedir())).toBe(false);
  });

  test('the production default for the pointer directory is not the real one', () => {
    expect(pointerDir(process.env)).not.toBe(
      join(homedir(), '.tincan', 'peers', 'claude-code'),
    );
    expect(pointerDir(process.env).startsWith(homedir())).toBe(false);
  });

  /**
   * An ambient session id makes the suite behave differently depending on who
   * ran it: these are exactly the values that decide whether a runtime arm
   * thinks it is hosted, and which session it believes it is.
   */
  test.each(['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_PID', 'CLAUDE_CONFIG_DIR'])(
    'the ambient %s of whoever ran the suite is not visible to it',
    (key) => {
      expect(process.env[key]).toBeUndefined();
    },
  );
});
