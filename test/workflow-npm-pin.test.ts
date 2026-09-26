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
    const rank = (v: string): number => {
      const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
      return major * 1e6 + minor * 1e3 + patch;
    };
    expect(rank(npmPin('.github/workflows/publish.yml') ?? '0.0.0')).toBeGreaterThanOrEqual(
      rank('11.5.1'),
    );
  });

  /**
   * The pin is a fact about this repository, and RELEASING.md states it twice
   * in prose a contributor is expected to act on. Nothing checked either copy.
   *
   * That is the class of drift the ci-cd-standard self-check explicitly cannot
   * see: not a malformed file, but a true sentence that a later commit makes
   * untrue. 716e11c did exactly that to this file's own toolchain callout —
   * pinned npm in both workflows and left the paragraph above saying the
   * release runs on a toolchain CI never exercised. Everything still parsed,
   * every test stayed green, and the sentence was simply false for a day.
   *
   * So the claim is tied to the thing it describes: bumping the pin without
   * updating what the docs promise now puts both in the same diff.
   */
  test('RELEASING.md documents the pin the workflows actually install', () => {
    const doc = repoFile('RELEASING.md');
    const pin = npmPin('.github/workflows/ci.yml');

    const declared = [...doc.matchAll(/^\s*NPM_VERSION:\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
    expect(declared, 'RELEASING.md shows no NPM_VERSION block').not.toEqual([]);
    for (const v of declared) expect(v).toBe(pin);

    const prose = /Supported npm for building and packing this repository: ([0-9][^.]*\.[^.]*\.[^.*]*)\./.exec(doc);
    expect(prose, 'RELEASING.md no longer names a supported npm version').not.toBeNull();
    expect(prose![1]).toBe(pin);
  });

  test('the shared standard illustrates the pin without dating itself to ours', () => {
    // docs/ci-cd-standard.md is generic guidance carried independently by
    // three repos that may legitimately pin different versions. A real
    // version number there reads as this repo's pin, goes stale the moment
    // one of them moves, and cannot be checked by any of them without
    // coupling the standard to one repo's choice. A placeholder cannot rot.
    const standard = repoFile('docs/ci-cd-standard.md');
    const concrete = [...standard.matchAll(/^\s*NPM_VERSION:\s*'([^']+)'\s*$/gm)]
      .map((m) => m[1])
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v ?? ''));
    expect(concrete).toEqual([]);
  });

  test('both workflows actually use the pin they declare', () => {
    for (const wf of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
      expect(repoFile(wf), `${wf} declares NPM_VERSION but never installs it`)
        .toContain('npm install -g npm@${{ env.NPM_VERSION }}');
    }
  });
});
