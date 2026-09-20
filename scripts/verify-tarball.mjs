#!/usr/bin/env node
// Verify what `npm pack` would actually ship. A published version is
// immutable, so a stray source tree or secret-shaped dotfile is far cheaper to
// catch here than in a release nobody can take back.
//
// Two independent checks, because they catch different mistakes:
//
//   1. ALLOWLIST — every packed path must sit under package.json `files`.
//      `files` is already an allowlist, so this is mostly a formality; it
//      earns its keep on npm's forced inclusions, which ship whether or not
//      `files` lists them (notably the `bin` and `main` targets). A bin
//      pointing outside `files` is the realistic escape.
//
//   2. DENYLIST — no packed path may look like source, tests, dependencies or
//      a dotfile. This is the check with teeth: adding "src" or "." to `files`
//      sails through the allowlist by definition, and only a denylist notices.
//
// Exits non-zero naming every offending path.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!pkg.files?.length) {
  console.error('package.json has no `files` allowlist — refusing to guess what should ship.');
  process.exit(1);
}

// npm includes these regardless of `files`.
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'LICENCE', 'CHANGELOG.md'];
const allow = [...pkg.files, ...ALWAYS];

// Paths that must never ship, even if `files` were widened to admit them.
// Anything deliberately shipped from these trees goes in EXCEPTIONS, so the
// exception is visible in review rather than hidden in a glob.
const FORBIDDEN = [
  { re: /^src\//, why: 'source tree' },
  { re: /^test\//, why: 'tests' },
  { re: /^tests\//, why: 'tests' },
  { re: /^node_modules\//, why: 'dependencies' },
  { re: /(^|\/)\.[^/]+$/, why: 'dotfile' },
  { re: /^\.github\//, why: 'CI configuration' },
  { re: /\.tsbuildinfo$/, why: 'build cache' },
];

// Deliberate, reviewed exceptions to FORBIDDEN.
// The address-format fixture ships on purpose: consumers implement against it,
// and it is the staleness check on their copy. See CANONICAL_ID.md.
const EXCEPTIONS = new Set(['test/fixtures/canonical-id.json']);

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
);

// npm <= 11 returns an array of results; npm 12 returns an object keyed by
// package name. Accept both — the publish job runs `npm install -g npm@latest`,
// so the shape changes under us without any change here.
const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
if (!entry?.files) {
  console.error('could not read a file list from `npm pack --dry-run --json`.');
  console.error(`npm ${process.env.npm_config_user_agent ?? ''} returned an unrecognised shape:`);
  console.error(JSON.stringify(packed).slice(0, 400));
  process.exit(1);
}
const files = entry.files.map((f) => f.path);

const under = (p, a) => p === a || p.startsWith(a.replace(/\/$/, '') + '/');
const problems = [];

for (const p of files) {
  if (EXCEPTIONS.has(p)) continue;
  if (!allow.some((a) => under(p, a))) problems.push(`${p} — outside package.json "files"`);
  const hit = FORBIDDEN.find((f) => f.re.test(p));
  if (hit) problems.push(`${p} — ${hit.why}, must never ship`);
}

if (problems.length) {
  console.error(`${problems.length} problem(s) with the publish tarball:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nEither stop packing it, or add a reviewed exception in scripts/verify-tarball.mjs.');
  process.exit(1);
}

console.log(`tarball verified — ${files.length} files`);
for (const p of files) console.log(`  ${p}`);
