# Working on Tin Can

## Vocabulary — these are instructions, not topics to discuss

Mike uses these words to mean specific actions. When he says one, **do it.**
Do not ask which bump, do not ask whether to publish, do not offer to do it —
the asking is the thing he does not want.

### "cut" / "cut a release"

Means the **whole release, including the npm publish**. One command:

```bash
npm version <patch|minor|major> -m "%s — <what changed>"
```

That rewrites all five version sites, commits, tags, and pushes commit and tag.
**The pushed `v*` tag is what publishes** — `.github/workflows/publish.yml`
fires on it and publishes BOTH `@brutalsystems/tincan` and
`@brutalsystems/tincan-opencode` over OIDC. There is no separate `npm publish`
step to run, and there is no npm token anywhere in the release path.

Consequences worth holding on to:

- **Pushing the tag IS publishing.** Never say a cut is "not published to npm";
  by the time the tag is on the remote, the publish is already running.
- **Always pass `-m`.** The GitHub Release is created with `--notes-from-tag`,
  so a cut without a message leaves the public release record reading just
  `0.9.0` for the whole release. Write what changed.
- Pick the bump yourself from what actually changed. See
  [RELEASING.md](./RELEASING.md), "Choosing the version" — an address-format
  change is **major** even when it looks like a bugfix.

### Two of those are tincan-only — do not carry them to muster or birddog

The three repos share the pipeline ([docs/ci-cd-standard.md](./docs/ci-cd-standard.md))
but not these, and getting it backwards sends you hunting a bug that is not
there:

- **`--notes-from-tag` is tincan's because tincan has no `RELEASE_NOTES.md`;
  the tag annotation *is* its release record.** muster extracts the version's
  section from `RELEASE_NOTES.md` and passes `--notes-file`, so a missing `-m`
  cannot empty its release body — and muster will not cut at all until a
  non-empty `## Unreleased` section exists. Check which shape a repo has before
  repeating the `-m` warning in it.
- **tincan follows normal semver.** muster fixes the bump in its own
  RELEASING.md: while it is 0.x, *minor* is the breaking-change signal — minor
  only for an incompatible interface or permission-default change, patch for
  everything else including new features. That rule is muster's, not a house
  style; applying it here would make every feature a patch.

What IS shared: the pushed tag publishes, over OIDC, with no separate
`npm publish` and no token.

### `allow-scripts` — tincan needs no entry, and never blind-write the key

`~/.npmrc`'s `allow-scripts` is **user-level, so all three repos share one
value**, and `npm config set` **replaces** it rather than appending. A bare set
therefore silently drops every other repo's entries, and the failure is quiet:
the install reports the new version while something is left unbuilt. Read the
current value and set the **union**, or leave it alone.

**tincan must not be added to it.** Verified: neither `@brutalsystems/tincan`
nor `@brutalsystems/tincan-opencode` declares `install`, `preinstall`,
`postinstall` or `prepare`, and the whole installed dependency tree carries only
`prepack` and `prepare` — `prepack` runs when a tarball is *built*, and
`prepare` does not run for a published tarball installed from the registry. So
nothing in tincan's install path wants to execute anything, and listing it would
assert otherwise. Birddog is the same (no install scripts, no dependencies at
all). Only muster genuinely needs an entry, because its `postinstall` builds
node-pty.

It is Mike's config, not ours: report what it should say, don't write it.

### "...and update globally"

Means: **watch the run, then install the published version on this machine**,
so Mike can `cd` into any local path and run the `tincan` CLI at the version
just shipped.

```bash
gh run watch --repo BrutalSystems/tincan --exit-status   # wait for the publish
npm install -g @brutalsystems/tincan@<version>           # then install it here
tincan --version                                         # and prove it
```

Do not install before the run finishes — the registry lags the publish by a
minute or two, and an install that races it either 404s or silently fetches
the previous version. Verify with `tincan --version` and report what it
printed; "installed" without the version is not an answer.

## Before claiming anything about the release pipeline

Read [RELEASING.md](./RELEASING.md) and `.github/workflows/publish.yml`.
`package.json`'s scripts alone will mislead you: they show `version` and
`postversion` but not the tag-triggered publish, which is the part that
actually ships.

## Issues

The GitHub issues go stale — several describe behaviour that has since been
fixed or changed. **Verify every claim against the current code before acting
on one**, and say plainly in the issue when the premise no longer holds.

## Testing

`npm test` runs the core and plugin suites together (`vitest run`);
`npm run typecheck:plugin` typechecks the plugin against its own tsconfig. Both
must pass before a cut — CI runs them again, but finding it locally is cheaper.

Write the test first, and **confirm it fails for the right reason before
implementing**. For a regression test on code that already works, break the
code deliberately, watch the test fail, then restore it. A test that has never
failed has not been shown to test anything.

Edit files with heredocs or the editing tools, never `python3 -c "..."` with
nested quotes — the shell mangles escapes, and `\b` in a regex became a literal
backspace byte that rendered invisibly in the failure output and cost real time
to find.
