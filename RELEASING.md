# Releasing Tin Can

> The pipeline itself — why it is shaped this way, and what muster shares with
> it — is [docs/ci-cd-standard.md](./docs/ci-cd-standard.md). This file is the
> tincan-specific procedure.

## Before you start

- Publish rights on the `@brutalsystems` npm scope.
- `NPM_TOKEN` available from wherever you keep secrets — a **granular** token
  scoped to `@brutalsystems`, not a classic account-wide one. Or skip the token
  and authenticate interactively; see [Publishing](#publishing).

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

**1. Bump four files, not one.**

```jsonc
// package.json
"version": "0.1.2"

// test/fixtures/canonical-id.json
"tincan_version": "0.1.2"
```

```ts
// plugins/opencode/tincan-lib/types.ts
export const PLUGIN_VERSION = '0.1.2';
```

```markdown
<!-- CANONICAL_ID.md, line 3 -->
> **Normative for `@brutalsystems/tincan` 0.1.2.**
```

The suite asserts the first three match. That is deliberate: the fixture
records which Tin Can its expectations were verified against, and consumers use
it as a staleness check on their copy; the plugin reports its version to
opencode, and a plugin claiming a version the server does not have is worse
than no version at all. A release cannot silently leave any of them behind.

`CANONICAL_ID.md`'s header is **not** asserted by any test — it is prose, and
the only one of the four you can forget without the build telling you.

**2. Build and test.**

```bash
npm run build && npm test
```

**3. Check what will actually ship.**

```bash
npm pack --dry-run
```

The tarball should contain `dist/`, `README.md`, `LICENSE`, `CANONICAL_ID.md`
and `test/fixtures/canonical-id.json` — the contract ships with the package so
that anyone installing from the registry can read the rules they are bound by.
Nothing else: no source, no tests, no `node_modules`.

**4. Commit, tag, push.**

```bash
git commit -am "0.1.2 — <what changed>"
git tag -a v0.1.2 -m "0.1.2"
git push origin main --tags
```

**5. Push the tag — that publishes.** See [Publishing](#publishing).

**6. Verify against the registry, not against your working copy.**

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

So the normal release is steps 1-4 and then nothing — watch the run:

```bash
git push origin main --tags
gh run watch --repo BrutalSystems/tincan
```

**There is no npm token.** Authentication is npm trusted publishing over
OIDC: the registry trusts this repository, this workflow *filename*, and the
`npm` environment, and issues a short-lived credential to the run. Nothing
long-lived is stored in GitHub, so there is nothing to rotate, nothing to
expire unnoticed, and nothing to leak from a public repository's secret store.
Provenance is generated automatically as a consequence.

Three things break it:

- **Renaming `.github/workflows/publish.yml`.** The trust is pinned to the
  filename. Rename it and publishing fails until the trusted publisher is
  reconfigured on npmjs.com.
- **Removing `environment: npm` from the job**, or renaming that environment.
  It is part of the trust, not decoration.
- **Publishing on a runner with npm < 11.5.1.** Node 22 ships npm 10.x, so the
  publish job pins Node 24. The `engines` floor stays `>=22` and CI still tests
  on 22 — only the publishing runner has to be newer.

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
npm login                     # interactive, prompts for the OTP
npm trust github @brutalsystems/tincan \
  --file publish.yml --repo BrutalSystems/tincan --env npm
```

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
