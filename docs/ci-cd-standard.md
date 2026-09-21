# CI/CD standard — BrutalSystems npm packages

This is the shared CI/CD standard for BrutalSystems' Node/npm packages
(currently muster, Tin Can and birddog). Each repo implements it identically;
changes here should be proposed to each at once. No secrets, tokens, session
IDs, or private paths belong in this file or in the workflows it describes —
each repo is public.

Two workflows per repository, same filenames everywhere:

| File | Trigger | Job |
|---|---|---|
| `.github/workflows/ci.yml` | push and PR to `main` | build, typecheck, test, tarball check |
| `.github/workflows/publish.yml` | push of a `v*.*.*` tag | release |

The filenames are part of the contract, not a preference: a trusted publisher
is registered against a specific workflow **filename**, so renaming the file
breaks publishing until the registration is redone.

## Publishing uses OIDC, never a token

Releases authenticate with [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers). The registry issues a
short-lived credential to the workflow run in exchange for GitHub's OIDC
identity.

**No `NPM_TOKEN` secret exists in either repository.** Nothing to rotate,
nothing to expire unnoticed, nothing to leak from a public repo's secret
store. Provenance is generated as a consequence, so consumers can verify which
workflow run built the artifact.

This is also where npm is heading: it now refuses 2FA-bypassing granular
tokens for package configuration changes, and warns that it is restricting
them for direct publishing too.

The publish job declares:

```yaml
permissions:
  contents: write   # create the GitHub Release
  id-token: write   # OIDC: the npm credential itself, and provenance
environment: npm
```

`environment: npm` is **mandatory**. It is part of the trusted-publisher
identity, and it is where a required reviewer goes — which matters, because
OIDC widens publish rights from "whoever holds the token" to "whoever can push
a tag". npm says exactly that when trust is established: *"anyone with GitHub
repository write access can publish."*

### npm version floor

Trusted publishing needs npm >= 11.5.1, and Node 22 ships npm 10.x. Keep the
runner on the repository's `engines` floor and upgrade npm instead:

```yaml
- run: npm install -g npm@latest
```

Pinning a newer Node on the publish runner also works, but then the artifact
is built on a runtime the package does not claim to support.

## Pipeline order

Cheapest checks first, so a bad release fails in seconds rather than after a
full install and test run.

Cheapest checks first, so a bad release fails in seconds rather than after a
full install and test run. A **fork guard** — `if: github.repository ==
'BrutalSystems/<repo>'` — sits on the job itself, before any of this.

1. **Tag matches `package.json`.** Fails the run. A published version is
   immutable, so shipping the wrong number is not recoverable.
2. **Release notes finalized**, if the repository keeps them. A repository
   with a `RELEASE_NOTES.md` extracts that version's section and fails if it
   is missing or still marked unreleased. A repository without one skips this
   and uses the tag annotation at step 12.
3. **Already published?** If the registry already serves this version, finish
   **green with nothing to do**. A re-pushed tag, or a release published by
   hand, is not an error. **This guard must never be hardened into a failing
   check** — step 1 is what catches a genuine mistake.
4. **Install, build, test** — `npm ci`, build, typecheck, the unit suite.
5. **Contract or integration suite**, where the repository has one — run
   against a real installed dependency, not against the unit tests' fakes.
6. **Pack** — `npm pack`.
7. **Verify the tarball** — `node scripts/verify-tarball.mjs`, see below.
8. **Smoke-test that exact tarball.** Install it into an empty temp prefix and
   run the binary. Nothing else in the pipeline notices a broken `bin`, a
   missing `dist` file, or a bad shebang, because unit tests import source
   rather than the package.
9. **Publish that tarball**, not the directory — `npm publish <tarball>
   --provenance` — so what ships is exactly what was smoke-tested.
10. **Confirm the registry serves it.** Poll `npm view`; publishes lag one to
    two minutes. Print `dist.integrity`.
11. **Verify the published artifact matches what was tested.** Download it
    back and diff its file list against the tarball packed at step 6 and
    tested at step 8 — *not* a re-run of step 7's rules, since two different
    compliant lists could both pass those. Skip, do not fail, if the registry
    has not replicated the tarball after retries: the publish already
    succeeded and was confirmed at step 10.
12. **Create the GitHub Release.** Mandatory. From the release notes if the
    repository has them, otherwise `gh release create --notes-from-tag`.

> **The release runs on a toolchain no CI run has exercised.** `npm install -g
> npm@latest` in the publish job means anything shelling out to npm must
> tolerate a version CI never saw. This is not hypothetical: npm 12 changed
> `npm pack --json` from an array to an object keyed by package name, which
> broke `verify-tarball.mjs` while every CI run stayed green — because CI runs
> it under the runner's older bundled npm.

## `scripts/verify-tarball.mjs`

Both repositories carry this script at the same path. It runs **two
independent checks** over `npm pack --dry-run --json`, because they catch
different mistakes:

**Allowlist** — every packed path must sit under `package.json` `files`. This
is mostly a formality, since `files` *is* an allowlist. It earns its keep on
npm's forced inclusions: the `bin` and `main` targets ship whether or not
`files` lists them, so a `bin` pointing outside `files` is the realistic
escape.

**Denylist** — no packed path may match `^src/`, `^test(s)/`,
`^node_modules/`, `^.github/`, any dotfile, or `.tsbuildinfo`. **This is the
check with teeth.** Widening `files` to `"src"` or `"."` passes the allowlist
by definition — the widened entry *is* the allowlist — and only a denylist
notices.

Anything deliberately shipped out of a denied tree goes in a named
`EXCEPTIONS` set, so the exception appears in review instead of hiding inside
a loosened pattern. Tincan has exactly one:
`test/fixtures/canonical-id.json`, which ships because consumers implement
against it.

> **A guard that has never been observed to fail is not a guard.** The
> allowlist-only version of this script was written first, and its negative
> test did not fire — removing an entry from `files` just stops packing the
> file, so there is no stray to find. Write the failing case and watch it fail
> before believing a check.

`ci.yml` runs the same script on every push, so tarball drift surfaces when it
is introduced rather than at release time.

## One-time setup, per package

Registering a trusted publisher **requires 2FA** — npm refuses the operation
to a token that bypasses it — so it cannot be scripted with a stored
credential. Do it once per package:

**Requires npm >= 12.** See the warning below — on npm 11 this fails with an
error that does not mention the npm version.

```bash
npm install -g npm@latest
npm login   # interactive, prompts for an OTP

# the environment must already exist on the GitHub side
gh api -X PUT repos/BrutalSystems/<repo>/environments/npm
```

**The package must already exist.** `npm trust` on a name the registry has
never seen answers `E404 ... Package not found`, so trust cannot be attached
before the first publish — and that first publish, coming from a human rather
than a workflow, has no provenance. Claim the name with a throwaway `0.0.0`
and let CI publish every version anyone installs. Publishing the real version
by hand also makes its release tag a green no-op, because the already-published
guard skips it and the GitHub Release step is gated behind the same condition.
Hit by tincan on 2026-09-20 and birddog on 2026-09-21; both times the failing
command was also mid-`npm login`, so unfinished auth may be the real cause —
publishing first works either way.

```bash
npm trust github @brutalsystems/<package> \
  --file publish.yml \
  --repo BrutalSystems/<repo> \
  --env npm \
  --allow-publish
```

Add required reviewers to that environment in the repository's **Settings →
Environments** if the publish set should be narrower than "anyone who can push
a tag".

The equivalent web route is the package's **Settings → Trusted Publisher →
GitHub Actions** on npmjs.com, with the same repository, workflow filename and
environment.

> **On npm 11.x this fails two different ways, and neither says "upgrade
> npm".** With `--allow-publish` you get `EUSAGE Unknown flag`, because the
> flag does not exist yet. Without it you get a bare `E400 Bad Request` with
> no explanation, because the registry requires a permissions field that npm
> 11 does not send. Same root cause, two unrelated-looking errors. `npm trust
> list <package>` is the useful diagnostic: if it answers, the credential is
> fine and the problem is the request, not the login.

## Releasing

1. Bump the version everywhere the repository keeps it. Prefer a test that
   asserts the copies agree, so a half-bump fails the build instead of
   shipping.
2. `npm run build && npm test`
3. Commit, tag `v<version>`, push both.
4. Watch the run: `gh run watch --repo BrutalSystems/<repo>`

Nothing else. The tag is the release trigger.
