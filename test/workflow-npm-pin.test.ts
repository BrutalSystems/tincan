import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The npm that packs the tarball is pinned, and pinned in two files.
 *
 * #15: the same commit packed differently under npm 10 (CI, whatever Node 22
 * shipped) and npm 12 (a laptop), because npm's forced-inclusion rules differ
 * between majors — `plugins/opencode/LICENSE` shipped on one and not the
 * other. Pinning fixes that only for as long as the two pins agree, and
 * nothing about a half-bumped pin looks wrong on the page: both files still
 * parse, both still run, and the disagreement shows up as a tarball that
 * differs from the one CI verified.
 *
 * So this is the same guard `check-version` puts on the four version sites,
 * applied to the fifth thing this repo keeps in more than one place.
 */
const repoFile = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8');

/** The workflow-level `NPM_VERSION:` value, as written. */
function npmPin(workflow: string): string | undefined {
  return /^\s*NPM_VERSION:\s*'([^']+)'\s*$/m.exec(repoFile(workflow))?.[1];
}

describe('the npm pin', () => {
  test('ci.yml and publish.yml pin the same npm', () => {
    const ci = npmPin('.github/workflows/ci.yml');
    const publish = npmPin('.github/workflows/publish.yml');

    // Asserted before the comparison: two undefineds are equal, and would
    // otherwise report agreement from a workflow that pins nothing at all.
    expect(ci, 'ci.yml has no workflow-level NPM_VERSION').toBeDefined();
    expect(publish, 'publish.yml has no workflow-level NPM_VERSION').toBeDefined();
    expect(publish).toBe(ci);
  });

  test('the pin satisfies the trusted-publishing floor of 11.5.1', () => {
    const pin = npmPin('.github/workflows/publish.yml');
    const [major, minor, patch] = (pin ?? '0.0.0').split('.').map(Number);
    const floor = [11, 5, 1];
    const rank = major * 1e6 + minor * 1e3 + patch;
    expect(rank).toBeGreaterThanOrEqual(floor[0] * 1e6 + floor[1] * 1e3 + floor[2]);
  });

  test('both workflows actually use the pin they declare', () => {
    for (const wf of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
      expect(repoFile(wf), `${wf} declares NPM_VERSION but never installs it`)
        .toContain('npm install -g npm@${{ env.NPM_VERSION }}');
    }
  });
});
