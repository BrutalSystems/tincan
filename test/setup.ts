/**
 * Runs before every test file, via `setupFiles` in vitest.config.ts.
 *
 * Two jobs, both about the machine the suite runs on rather than about any
 * behaviour under test.
 *
 * **Point TINCAN_HOME somewhere disposable.** With it unset, `pointerDir` falls
 * back to `~/.tincan` (`src/claude/registry.ts`), and the registry writes there:
 * `unlinkSync(recordPath(dir, sessionId))` removes a pointer record, and
 * `messagesPath` appends to `~/.tincan/messages.jsonl`. A test that builds a side
 * or a MessageLog without passing an explicit home therefore edits the real one.
 * Deleting a live session's pointer makes that peer report `can_reply: false` and
 * leaves it unrepliable until it registers again — on the machine of whoever ran
 * `npm test`, while they were using it.
 *
 * **Strip the ambient session.** These four variables decide whether a runtime
 * arm believes it is hosted, and which session it believes it is. Left in place,
 * the suite behaves differently depending on who ran it and from where: the same
 * test passes on CI and fails in a terminal that happens to be inside a Claude
 * Code session. `src/claude/sweep.ts` reads the real socket directories through
 * `socketDirCandidates` and is only kept off them by an opt-in per-test seam, so
 * an ambient session id is also how a forgotten seam finds live peers.
 *
 * Neither of these replaces the per-test seams. They make the floor safe so that
 * forgetting one is a wrong result rather than a change to the machine.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One directory per worker, not one per suite: vitest runs test files in
 * parallel across workers, and a shared home would let two files see each
 * other's pointer records and message log.
 */
const home = mkdtempSync(join(tmpdir(), 'tincan-test-home-'));
process.env.TINCAN_HOME = home;

/**
 * Deleted rather than set to '', because the arms distinguish the two: an empty
 * OPENCODE_PID is its own tested case (`Number('')` is 0, which is an integer),
 * so blanking these would substitute one ambient value for another.
 */
for (const key of [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CONFIG_DIR',
  'CODEX_THREAD_ID',
  'OPENCODE_PID',
]) {
  delete process.env[key];
}

// Best effort: the OS clears tmp eventually, but a suite run every few minutes
// should not leave a directory behind each time.
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* the OS will get it */
  }
});
