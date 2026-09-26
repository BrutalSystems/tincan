import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every CI job carries a wall-clock bound.
 *
 * This exists because of a specific seventeen minutes. A test in
 * `cli-idempotency.test.ts` pointed `mkdirSync` at `/proc/nonexistent/...`,
 * which on macOS is an instant error and on the Linux runner is a live procfs.
 * The file never completed, vitest waited for it, `npm test` produced no output
 * at all, and the publish job for v1.10.0 sat until a human cancelled it. The
 * tag was already pushed; nothing shipped.
 *
 * The reason a timeout is the right guard, rather than only fixing that test:
 * **`vitest`'s `testTimeout` cannot catch this class at all.** It is implemented
 * with timers, and a SYNCHRONOUS call that blocks holds the event loop, so the
 * timer never runs. `FileIdempotencyStore` is synchronous throughout, which is
 * the correct design for it — so the bound has to come from outside the process.
 *
 * GitHub's default is 360 minutes. That is not a bound, it is a weekend.
 */
const repoFile = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8');

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/publish.yml'];

/** Job ids — two-space indented keys under `jobs:`. */
function jobNames(yaml: string): string[] {
  const after = yaml.slice(yaml.indexOf('\njobs:'));
  return [...after.matchAll(/^ {2}([a-z][\w-]*):$/gim)].map((m) => m[1]!);
}

function timeouts(yaml: string): number[] {
  return [...yaml.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
}

describe('every CI job is time-bounded', () => {
  test.each(WORKFLOWS)('%s declares a timeout for each job', (workflow) => {
    const yaml = repoFile(workflow);
    const jobs = jobNames(yaml);
    // Guard the guard: if the job-name scrape ever breaks, the count comparison
    // below would pass vacuously against an empty list.
    expect(jobs.length, `no jobs parsed out of ${workflow}`).toBeGreaterThan(0);
    expect(
      timeouts(yaml).length,
      `${workflow} has ${jobs.length} job(s) (${jobs.join(', ')}) but ` +
        `${timeouts(yaml).length} timeout-minutes`,
    ).toBe(jobs.length);
  });

  test.each(WORKFLOWS)('%s sets a bound that is short enough to matter', (workflow) => {
    for (const minutes of timeouts(repoFile(workflow))) {
      // The whole suite runs in seconds and the publish job in a few minutes.
      // A generous ceiling still turns "sat until someone noticed" into "failed
      // while the person who pushed it was still watching".
      expect(minutes).toBeGreaterThan(0);
      expect(minutes).toBeLessThanOrEqual(30);
    }
  });
});
