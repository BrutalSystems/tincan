# CI/CD standard — BrutalSystems npm packages

> Shared between [tincan](https://github.com/BrutalSystems/tincan) and
> [muster](https://github.com/BrutalSystems/muster). This file exists at the
> same path in both repositories and should say the same thing in both. If
> they disagree, one of them was edited without the other and the
> disagreement is the bug.

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

1. **Fork guard** — `if: github.repository == 'BrutalSystems/<repo>'`. OIDC
   would refuse a fork anyway; the gate stops a confusing red run in someone
   else's copy.
2. **Tag matches `package.json`.** Fails the run. A published version is
   immutable, so shipping the wrong number is not recoverable.
3. **Already published?** If the registry already serves this version, finish
   **green with nothing to do**. A re-pushed tag, or a release published by
   hand, is not an error. This is the one guard that must not fail the run —
   step 2 is what catches a genuine mistake.
4. **Release notes** (optional source, mandatory Release). A repository with a
   `RELEASE_NOTES.md` extracts that version's section and fails if it is
   missing or still marked unreleased. A repository without one uses the tag
   annotation via `gh release create --notes-from-tag`. Either way the run
   creates a GitHub Release.
5. `npm ci`, build, typecheck, test.
6. **Contract suite**, where the repository has one — run against a real
   installed dependency, not against the unit tests' fakes.
7. `npm pack`.
8. **Verify the tarball** — `node scripts/verify-tarball.mjs`, see below.
9. **Smoke-test the packed artifact.** Install the tarball into an empty temp
   prefix and run the binary. Nothing else in the pipeline notices a broken
   `bin`, a missing `dist` file, or a bad shebang, because unit tests import
   source rather than the package.
10. **Publish the tarball**, not the directory — `npm publish <tarball>
    --provenance` — so what ships is exactly what was smoke-tested.
11. **Confirm the registry serves it**, and print `dist.integrity`. Publishes
    lag one to two minutes; poll rather than asserting once.
12. **Verify the published artifact.** Download it back with `npm pack
    <package>@<version>` and diff its file list against the tarball this run
    packed. Every earlier check inspects a local build; this is the only one
    that sees what a consumer actually downloads. Skip it — do not fail —
    when the registry has not caught up, since the publish itself already
    succeeded.
13. **Create the GitHub Release.**

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

```bash
npm login   # interactive, prompts for an OTP

npm trust github @brutalsystems/<package> \
  --file publish.yml \
  --repo BrutalSystems/<repo> \
  --env npm
```

Then create an environment named `npm` in the repository's **Settings →
Environments** (add required reviewers there if the publish set should be
narrower than "anyone who can push a tag").

The equivalent web route is the package's **Settings → Trusted Publisher →
GitHub Actions** on npmjs.com, with the same repository, workflow filename and
environment.

> `npm trust` has `--allow-publish` / `--allow-stage-publish` flags in the
> published documentation, but **npm 11.13.0 rejects them** with `EUSAGE
> Unknown flag` — the docs describe a newer CLI than the released one. Omit
> them. If a future npm starts requiring a permission flag, add it then.

## Releasing

1. Bump the version everywhere the repository keeps it. Prefer a test that
   asserts the copies agree, so a half-bump fails the build instead of
   shipping.
2. `npm run build && npm test`
3. Commit, tag `v<version>`, push both.
4. Watch the run: `gh run watch --repo BrutalSystems/<repo>`

Nothing else. The tag is the release trigger.
