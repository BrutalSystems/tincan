import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * This repository checks its OWN copy of docs/ci-cd-standard.md.
 *
 * It reads no sibling repository and makes no network call, so nothing here
 * can fail because muster or birddog moved. That is the point: the three
 * repos are independent by decision, and a check that reached across them
 * would quietly rebuild the dependency that decision removed.
 *
 * What it cannot do is see semantic drift between the copies — nothing
 * self-contained can. What it does catch is the mechanical drift, which is
 * the kind that actually happened three times in one week: two-repo wording
 * left behind when a third repo appeared, a repo-specific fact written as if
 * it were shared, a section duplicated rather than moved.
 *
 * Proposed by birddog and written first in muster, where it caught two faults
 * on its first run — one of them the marked-note convention being broken by
 * the person introducing it, within the hour. The convention without the
 * check is an intention.
 */
const DOC = 'docs/ci-cd-standard.md';
const text = readFileSync(join(import.meta.dirname, '..', DOC), 'utf8');
const lines = text.split('\n');

/** This repo's name, as the marked-note convention spells it. */
const SELF = 'tincan';

/** Facts true of this repository and no other. Each must be inside a marked note. */
const REPO_SPECIFIC_FACTS = ['test/fixtures/canonical-id.json'];

const headings = lines.filter((l) => /^#{1,3} /.test(l)).map((l) => l.replace(/^#+ /, ''));

/** The line indices covered by a `> **Repository-specific, <repo>.**` block. */
function markedNoteLines(): Set<number> {
  const covered = new Set<number>();
  let open = false;
  lines.forEach((line, i) => {
    if (/^> \*\*Repository-specific, [^*]+\.\*\*/.test(line)) open = true;
    else if (!line.startsWith('>')) open = false;
    if (open) covered.add(i);
  });
  return covered;
}

describe('docs/ci-cd-standard.md', () => {
  test('carries no two-repository wording', () => {
    // There have been three repos since birddog. Every one of these read as
    // fact while being false, and none of them looked wrong on the page.
    const offenders = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /both repositor|either repositor|shared between/i.test(l));
    expect(offenders).toEqual([]);
  });

  test('claims no sameness between the copies', () => {
    // The repos are independent by decision, so the copies WILL diverge and
    // that is a consequence rather than a defect. A standing claim of
    // sameness rots into a lie the moment one of them moves — this file
    // carried exactly such a claim while contradicting itself for months.
    const offenders = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) =>
        /implements it identically|say the same thing|read identically|should be identical/i.test(l),
      );
    expect(offenders).toEqual([]);
  });

  test('states its provenance as a dated fact, with no status claim', () => {
    // A dated fact does not become false, it becomes old — and a reader can
    // see how old. Anything about what is in flight elsewhere is a status
    // claim, and status rots immediately.
    expect(text).toMatch(/last reconciled with [^,]+, \d{4}-\d{2}-\d{2}/i);
  });

  test('every repository-specific fact sits inside a marked note', () => {
    const marked = markedNoteLines();
    const unmarked = REPO_SPECIFIC_FACTS.flatMap((fact) =>
      lines
        .map((l, i) => [i, l] as const)
        .filter(([i, l]) => l.includes(fact) && !marked.has(i))
        .map(([i]) => `${DOC}:${i + 1} — ${fact} outside a marked note`),
    );
    expect(unmarked).toEqual([]);
  });

  test('its marked notes name this repository', () => {
    const wrong = lines
      .filter((l) => /^> \*\*Repository-specific, /.test(l))
      .filter((l) => !l.includes(`Repository-specific, ${SELF}.`));
    expect(wrong).toEqual([]);
  });

  test('carries the agreed sections, in the agreed order', () => {
    const agreed = [
      'Two workflows',
      'Publishing uses OIDC, never a token',
      'npm version floor',
      'Fork guard',
      'Pipeline order',
      '`scripts/verify-tarball.mjs`',
      'One-time setup, per package',
      'Releasing',
    ];
    const found = headings.filter((h) => agreed.includes(h));
    expect(found).toEqual(agreed);
  });

  test('the fork guard is DEFINED once, under its own heading', () => {
    // Lifting it is the same operation that created the duplicate paragraph
    // this file carried from 0.5.1: a sentence added by re-pasting the
    // paragraph it belonged to, leaving both. So the assertion is on the
    // guard's definition, not on the words "fork guard" — a cross-reference
    // from Pipeline order is how a reader finds it, and forbidding that would
    // push the file towards repeating the condition instead of pointing at it.
    const definition = lines
      .map((l, i) => [i, l] as const)
      .filter(([, l]) => /if:\s*github\.repository\s*==/.test(l));
    expect(definition).toHaveLength(1);

    const [at] = definition[0]!;
    const heading = lines
      .slice(0, at)
      .filter((l) => /^## /.test(l))
      .pop();
    expect(heading).toBe('## Fork guard');
  });

  test('no paragraph appears twice', () => {
    // The duplicate went unread for weeks in a file that claimed elsewhere to
    // be checked against two others.
    const prose = lines.filter((l) => l.length > 40 && !l.startsWith('|') && !l.startsWith('```'));
    const seen = new Map<string, number>();
    for (const l of prose) seen.set(l, (seen.get(l) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([l]) => l)).toEqual([]);
  });
});
