#!/usr/bin/env node
// One version, four files. package.json is the source; the other three are
// derived from it here and nowhere else.
//
// They cannot simply read package.json at runtime the way src/version.ts
// does — each is a literal for a reason:
//
//   - test/fixtures/canonical-id.json ships to consumers as the record of
//     which Tin Can its expectations were verified against. A fixture that
//     reported the *reader's* version would be useless as a staleness check.
//   - plugins/opencode/tincan-lib/types.ts ships untranspiled and is loaded
//     by opencode, not by us; it has no reliable path to our package.json.
//   - CANONICAL_ID.md is prose.
//
// So they stay literals, and stop being hand-edited. Two entry points:
//
//   node scripts/sync-version.mjs 0.6.0   set every site to 0.6.0
//   node scripts/sync-version.mjs         set the other three from package.json
//                                         (the `npm version` lifecycle case)
//   node scripts/sync-version.mjs --check report drift, change nothing (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Every place the version appears. A `read` that returns undefined means the
 * literal has moved, which is a hard error rather than a skipped file: a
 * silent no-op ships a release whose plugin reports the previous version.
 */
export const VERSION_SITES = [
  {
    file: 'package.json',
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    file: 'test/fixtures/canonical-id.json',
    read: (s) => JSON.parse(s).tincan_version,
    write: (s, v) => s.replace(/("tincan_version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    // The opencode plugin is published as its own package
    // (@brutalsystems/tincan-opencode) so opencode can install it by npm
    // specifier instead of the user copying files by hand. Two packages, one
    // version: they are installed by different tools at different times, so a
    // skew between them is precisely the failure this file exists to prevent.
    file: 'plugins/opencode/package.json',
    read: (s) => JSON.parse(s).version,
    write: (s, v) => s.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`),
  },
  {
    file: 'plugins/opencode/tincan-lib/types.ts',
    read: (s) => s.match(/PLUGIN_VERSION\s*=\s*'([^']*)'/)?.[1],
    write: (s, v) => s.replace(/(PLUGIN_VERSION\s*=\s*)'[^']*'/, `$1'${v}'`),
  },
  {
    file: 'CANONICAL_ID.md',
    // A semver-shaped capture, not `[^.]*` — the version itself contains
    // dots, so a dot-excluding capture stops at the first one and reports
    // "0" as the file's version.
    read: (s) => s.match(/Normative for `@brutalsystems\/tincan` (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\./)?.[1],
    write: (s, v) =>
      s.replace(
        /(Normative for `@brutalsystems\/tincan` )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\./,
        `$1${v}.`,
      ),
  },
];

const load = (dir, site) => {
  const path = join(dir, site.file);
  const text = readFileSync(path, 'utf8');
  const found = site.read(text);
  if (typeof found !== 'string' || found === '') {
    throw new Error(
      `${site.file}: no version literal found — it moved or was rewritten. ` +
        `Update VERSION_SITES in scripts/sync-version.mjs.`,
    );
  }
  return { path, text, found };
};

/** Write `version` into every site. Returns the files it actually changed. */
export function syncVersion(dir, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a semver version (no leading v, no range).`);
  }
  // Read and validate every site before writing any of them, so a moved
  // literal leaves the tree untouched rather than half-bumped.
  const sites = VERSION_SITES.map((site) => ({ site, ...load(dir, site) }));
  const changed = [];
  for (const { site, path, text, found } of sites) {
    if (found === version) continue;
    const next = site.write(text, version);
    if (next === text) throw new Error(`${site.file}: version literal did not rewrite.`);
    writeFileSync(path, next);
    changed.push(site.file);
  }
  return { changed };
}

/** Report drift against package.json without changing anything. */
export function checkVersion(dir) {
  const expected = load(dir, VERSION_SITES[0]).found;
  const mismatches = [];
  for (const site of VERSION_SITES.slice(1)) {
    const { found } = load(dir, site);
    if (found !== expected) mismatches.push({ file: site.file, found, expected });
  }
  return { ok: mismatches.length === 0, version: expected, mismatches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const arg = process.argv[2];
  try {
    if (arg === '--check') {
      const { ok, version, mismatches } = checkVersion(root);
      for (const m of mismatches) {
        console.error(`${m.file}: says ${m.found}, package.json says ${m.expected}`);
      }
      if (!ok) process.exit(1);
      console.log(`all ${VERSION_SITES.length} version sites agree: ${version}`);
    } else {
      const version = arg ?? checkVersion(root).version;
      const { changed } = syncVersion(root, version);
      console.log(
        changed.length === 0
          ? `already at ${version} — nothing to change`
          : `${version}: updated ${changed.join(', ')}`,
      );
    }
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
