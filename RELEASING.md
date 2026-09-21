# Releasing Tin Can

> The pipeline itself — why it is shaped this way, and what muster and birddog
> share with it — is [docs/ci-cd-standard.md](./docs/ci-cd-standard.md). This
> file is the tincan-specific procedure.

## Before you start

**For the normal release: push access to this repository, and nothing else.**
Publishing runs in CI and authenticates over OIDC, so there is no npm account,
no token and no local login in the release path — see
[Publishing](#publishing).

The prerequisites below apply only to
[publishing by hand](#publishing-by-hand), the fallback for when CI is
unavailable:

- Publish rights on the `@brutalsystems` npm scope.
- `NPM_TOKEN` in Keep (`keep unlock NPM_TOKEN`) — a **granular** token scoped
  to `@brutalsystems`, not a classic account-wide one. Or skip the token and
  authenticate interactively.

## Choosing the version

Ordinary code and documentation changes follow normal semver.

**One rule is specific to this project:** a change to the address format —
slugify, suffix derivation, collision handling or resolution — is a **major**
release, even if it looks like a bug fix. Those rules are a published contract
that other tools implement against, and a one-character change produces
addresses which resolve in one tool and fail silently in the other. See
[CANONICAL_ID.md](./CANONICAL_ID.md), "Changing this format".

Adding cases to `test/fixtures/canonical-id.json` is not breaking. Changing an
existing expected value is.

## Steps

**1. Commit your change**, as an ordinary commit. `npm version` needs a clean
tree, so the release is its own commit — that is the only reason this is two
steps and not one.

**2. Cut the release.**

```bash
npm version patch -m "%s — <what changed>"     # or minor / major
```

That is the whole release. It rewrites **all five** version sites, commits
them, creates the `v0.5.6` tag, and pushes commit and tag to `origin`, which
fires `publish.yml` — publishing both `@brutalsystems/tincan` and
`@brutalsystems/tincan-opencode` from the one run. Watch it:

```bash
gh run watch --repo BrutalSystems/tincan
```

The five sites are `package.json`, `plugins/opencode/package.json`,
`test/fixtures/canonical-id.json`,
`plugins/opencode/tincan-lib/types.ts` and `CANONICAL_ID.md` line 3, kept in
step by `scripts/sync-version.mjs` from the `version` lifecycle hook;
`postversion` does the push. `npm run check-version` reports drift without
changing anything, and CI runs it on every push.

They are literals rather than runtime reads of package.json for reasons the
script's header gives: the fixture is a staleness check consumers compare
against, the plugin ships untranspiled into opencode with no path to our
package.json, and the third is prose. The program's own version is *not* one
of them — `src/version.ts` reads package.json at runtime.

**If you need the pieces separately** — a dry run, or a release built by hand:
`npm run sync-version 0.5.6` rewrites the five sites and nothing else, leaving
the commit, tag and push to you. `npm version --no-git-tag-version` bumps
without committing. Neither publishes; only a pushed `v*` tag does.

**3. Build and test** — optional; CI does both, and `prepublishOnly` blocks
a broken build from shipping.

```bash
npm run build && npm test
```

**4. Check what will actually ship** — also run by CI on every push.

```bash
npm pack --dry-run
```

The tarball should contain `dist/`, `README.md`, `LICENSE`, `CANONICAL_ID.md`
and `test/fixtures/canonical-id.json` — the contract ships with the package so
that anyone installing from the registry can read the rules they are bound by.
Nothing else: no source, no tests, no `node_modules`.

**5. Verify against the registry, not against your working copy.**

```bash
npm view @brutalsystems/tincan version
```

**The registry lags a publish by one to two minutes.** A 404 or a stale version
immediately afterwards is normal and does not mean the publish failed — check
`npm access list packages @brutalsystems`, which updates immediately. Only worry
if the package is missing there.

To confirm the published artifact rather than trusting the build:

```bash
npm pack @brutalsystems/tincan@0.1.2 && tar tzf brutalsystems-tincan-0.1.2.tgz
```

## Publishing

**Publishing is tag-driven and runs in CI.** Pushing a `v*` tag triggers
`.github/workflows/publish.yml`, which refuses the release unless the tag
matches `package.json`, runs build, plugin typecheck and the full suite, and
packs, verifies the tarball, installs it into a temp prefix and runs the
binary, then publishes **that tarball** with npm provenance and creates a
GitHub Release from the tag annotation. Nothing publishes from a branch push.

If the version is already on the registry — a re-pushed tag, or a release
published by hand — the job says so and finishes green without republishing.
Shipping the *wrong* version is what the tag check catches, and that one
fails the run.

So the normal release is `npm version` and then nothing. A bare `git push`
sends the commit only: CI runs, nothing publishes.

**There is no npm token.** Authentication is npm trusted publishing over
OIDC: the registry trusts this repository, this workflow *filename*, and the
`npm` environment, and issues a short-lived credential to the run. Nothing
long-lived is stored in GitHub, so there is nothing to rotate, nothing to
expire unnoticed, and nothing to leak from a public repository's secret store.
Provenance is generated automatically as a consequence.

Four things break it:

- **Renaming `.github/workflows/publish.yml`.** The trust is pinned to the
  filename. Rename it and publishing fails until the trusted publisher is
  reconfigured on npmjs.com.
- **Removing `environment: npm` from the job**, or renaming that environment.
  It is part of the trust, not decoration.
- **Publishing on a runner with npm < 11.5.1.** Node 22 ships npm 10.x, so the
  publish job stays on Node 22 — the `engines` floor — and upgrades npm itself
  before publishing. Raising the runtime instead would mean releasing on a Node
  the floor does not cover.
- **Changing the npm pin in one workflow and not the other.** See below.

### The npm pin

`ci.yml` and `publish.yml` both declare a workflow-level `NPM_VERSION`, and
both install exactly it:

```yaml
env:
  NPM_VERSION: '12.0.2'
```

**Supported npm for building and packing this repository: 12.0.2.** A laptop
that packs with a different one may see a different tarball.

It is pinned rather than `npm@latest` because the npm version does not only
satisfy trusted publishing's >= 11.5.1 floor — it also decides what `npm pack`
puts in the tarball. #15: the same commit packed `plugins/opencode/LICENSE`
under npm 10 and omitted it under npm 12, so CI failed `verify-tarball.mjs` on
a commit whose local checks had passed. `latest` moves on npm's schedule and
would reintroduce that the day it next changes a forced-inclusion rule.

The `check` matrix in `ci.yml` deliberately does **not** get the pin. That job
exists to prove the `engines` floor, and forcing npm 12 onto its Node 22 leg
would stop exercising the npm a Node 22 user actually has.

To bump it: change the value in **both** workflows in the same commit.
`test/workflow-npm-pin.test.ts` fails the build if they disagree, if either
declares a pin it does not install, or if the pin drops below 11.5.1 — a
half-bump is otherwise invisible, since both files still parse and both still
run.

**Who can publish, now that CI can:** anyone able to push a tag to this
repository. npm says so out loud when trust is established — *"anyone with
GitHub repository write access can publish"*. That is a wider set than
"whoever holds the npm token", which is the point of the `npm` environment on
the publish job: add a required reviewer there in repo settings if that set
should be smaller.

### Establishing trust (once, and after any rename above)

Requires 2FA — npm refuses this operation to a token that bypasses it, so it
cannot be scripted with a stored credential. Either on npmjs.com under the
package's Settings → Trusted Publisher, or:

```bash
npm install -g npm@latest     # npm >= 12 required; npm 11 fails obscurely
                              # (your machine, for this one-time step — not
                              #  the runner pin above, which is exact)
npm login                     # interactive, prompts for the OTP
gh api -X PUT repos/BrutalSystems/tincan/environments/npm
npm trust github @brutalsystems/tincan \
  --file publish.yml --repo BrutalSystems/tincan --env npm --allow-publish
```

Done for tincan on 2026-09-20, permissions publish + stage publish. The trust
id is deliberately not recorded here — `npm trust list @brutalsystems/tincan`
prints it, and this file is public. Redo it only if the workflow filename or
the environment name changes.

#### The plugin package needs its own registration

**OIDC trust is per package, not per repository.** `@brutalsystems/tincan-opencode`
is published from the same workflow and the same `npm` environment, but npm
will refuse it until it has been trusted under its own name:

Bootstrapping a new package took two steps, in this order:

```bash
# 1. One hand publish, to create the name. publishConfig.access is "public"
#    in that manifest; a new scoped package is restricted by default.
( cd plugins/opencode && npm publish )

# 2. npm login if you are not already, then attach trust.
npm trust github @brutalsystems/tincan-opencode \
  --file publish.yml --repo BrutalSystems/tincan --env npm --allow-publish
```

The `npm` environment already exists, so there is no `gh api -X PUT` step.

That first hand-published version has **no provenance** — it cannot, not
coming from a workflow run. `@brutalsystems/tincan-opencode` 0.6.0 (hand,
21:34) has none; 0.6.1 (CI, 21:39) is signed, as is everything after it. If
you mind that, publish a throwaway `0.0.0` to claim the name and let the real
first version come from CI.

Trying step 2 first gives:

```
npm error code E404
npm error 404 Not Found - POST .../@brutalsystems%2ftincan-opencode/trust - Package not found
```

Whether that is strictly "the package must exist" is **not established** — the
attempt that failed was also still mid-`npm login`, printing "Authenticate
your account at: ...", so unfinished auth may be the real cause. Publishing
first works either way; that is why the order above is the order.

### A 404 from the registry proves nothing for several minutes

**`npm publish` is asynchronous.** It says so: *"Your package is being
processed and may take a few minutes to become available."* Here the
packument 404'd for **90 seconds** after a publish that had already signed its
provenance to the transparency log.

So a 404 — from `npm view`, or from `curl` straight at
`registry.npmjs.org`, cache bypassed — is **not** evidence that nothing was
published. Nor is its absence from a listing evidence either way:
`npm access list packages <scope>` shows a name once trust claims it, and
`npm trust list <package>` prints a registration regardless.

To actually know, use the timeline, which is authoritative the moment it
exists:

```bash
npm view @brutalsystems/tincan-opencode time --json
```

This cost a wrong edit to this file: a 404 two minutes after a successful
publish was read as "never published", and the bootstrap above was briefly
rewritten to say no hand publish was needed.

`prepublishOnly` runs the build and the full suite first, so a broken build
cannot ship, whether from CI or a laptop.

### Publishing by hand

Still supported, and the fallback when CI is unavailable. Everything below
assumes you have done steps 1-4 already.

**On Mike's machine, use Keep for unattended publishing.** `keep` is a shell
function loaded by interactive zsh. Unlock only the npm token in a subshell:

```bash
zsh -ic '(keep unlock NPM_TOKEN && npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN" --no-progress)'
```

Use this flow before interactive authentication. Never print the token or write
it to a file; the subshell discards the exported value when publishing finishes.

**Interactive** — prompts for a one-time password:

```bash
npm publish
```

**With a token** — no prompt, and the token never touches a file:

```bash
npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
```

Do not add the token to `~/.npmrc`. A token created with `--bypass-2fa`
publishes as you with no second factor; keeping it in a secret store and passing
it per invocation limits where it can leak from. `.npmrc` is gitignored as a
backstop, not as a suggestion.

## After publishing

A published version is **immutable**. Package metadata — repository URL, author,
license — is baked in per version, so fix those before publishing rather than
after. npm also disallows unpublishing after 72 hours, and discourages it well
before that.

To pick up a new release locally:

```bash
npm update -g @brutalsystems/tincan
```

Sessions configured with `command = "tincan"` get it on their next start.
Sessions pointed at a working copy do not — that is usually what you want while
developing.
