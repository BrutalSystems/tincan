import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * Every relative link in the published docs resolves.
 *
 * Added when the 1,193-line README was split into `docs/`, which broke
 * nineteen links in one commit — every in-page anchor that had pointed at a
 * README section, plus paths written relative to the repo root that were then
 * one directory off. None of that fails a build, and a dead link in a public
 * README is read as the project not being maintained.
 *
 * External URLs are deliberately not fetched: a test that needs the network is
 * a test that fails for reasons which have nothing to do with the change.
 */
const ROOT = resolve(import.meta.dirname, '..');

const docFiles = (): string[] => [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** GitHub's heading-to-anchor rule, near enough for our own headings. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (m?.[1] === undefined) continue;
    out.add(
      m[1]
        .toLowerCase()
        .replace(/[`*_[\]()]/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-'),
    );
  }
  return out;
}

interface Link {
  file: string;
  target: string;
  label: string;
}

function links(file: string): Link[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const md = [...text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)].map((m) => ({
    file,
    label: m[1] ?? '',
    target: m[2] ?? '',
  }));
  /**
   * HTML attributes too, not only markdown links.
   *
   * The logo is an `<img>` inside a `<picture>`, so the theme-swapped asset is
   * referenced by `srcset=` and the fallback by `src=` — neither of which is a
   * markdown link. A typo in either renders as a broken-image icon at the very
   * top of the README, which is the single worst place to have one, and the
   * markdown-only check above would not have noticed.
   */
  const html = [...text.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => ({
    file,
    label: 'html asset',
    target: m[1] ?? '',
  }));
  return [...md, ...html].filter((l) => !/^(https?:|mailto:|data:)/.test(l.target));
}

describe('documentation links', () => {
  const all = docFiles().flatMap(links);

  test('there are links to check, so this cannot pass vacuously', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  test('every relative path points at a file that exists', () => {
    const broken = all
      .filter((l) => !l.target.startsWith('#'))
      .filter((l) => !existsSync(resolve(ROOT, dirname(l.file), l.target.split('#')[0]!)));
    expect(broken.map((b) => `${b.file} -> ${b.target}`)).toEqual([]);
  });

  test('every anchor exists in the file it points into', () => {
    const cache = new Map<string, Set<string>>();
    const anchorsOf = (rel: string): Set<string> => {
      let a = cache.get(rel);
      if (a === undefined) {
        a = anchors(readFileSync(join(ROOT, rel), 'utf8'));
        cache.set(rel, a);
      }
      return a;
    };

    const broken: string[] = [];
    for (const l of all) {
      const [rawPath, frag] = l.target.split('#');
      if (frag === undefined || frag === '') continue;
      const path = rawPath ?? '';
      // Same-file anchor, or one in a sibling document.
      const rel =
        path === '' ? l.file : resolve(ROOT, dirname(l.file), path).slice(ROOT.length + 1);
      if (!rel.endsWith('.md') || !existsSync(join(ROOT, rel))) continue;
      if (!anchorsOf(rel).has(frag)) broken.push(`${l.file} -> ${l.target}`);
    }
    expect(broken).toEqual([]);
  });

  test('the README links to every document under docs/', () => {
    // A document nothing links to is one nobody finds. The split created eight
    // at once, and forgetting to list one in the table would be invisible.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const orphans = readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      // These two are referenced from other docs and from code comments rather
      // than from the README, deliberately: they are change notices, not
      // reference material a reader of the README is looking for.
      .filter((f) => !['change-notice-opencode.md', 'opencode-v2-prompt-defect.md', 'ci-cd-standard.md'].includes(f))
      .filter((f) => !readme.includes(`docs/${f}`));
    expect(orphans).toEqual([]);
  });
});
