# opencode keeps running a 0.7.2 Tin Can plugin

**Status:** closed — cache cleared, session relaunched on 2.4.0; "update globally" now clears it every release.

## Question

Mike asked to muster an opencode session (2026-10-07). It registered as
`misty-comet` (`ses_ee867168dffeKcXKdpNUGBELIs`) but its record says
`plugin_version: 0.7.2` while 2.4.0 is published. "yes continue" — find out why.

## Context

- muster 1.2.0; opencode 1.18.34 (`~/.opencode/bin/opencode`); tincan 2.4.0
  installed globally and published (both packages) the same day.
- `~/.muster/config.toml` loads the plugin by npm specifier:
  `[plugins.tincan] npm = "@brutalsystems/tincan-opencode"`.

## What was checked

- `~/.muster/config.toml` comment on `[plugins.tincan]` already says it:
  "opencode caches it under <pkg>@latest and does not revisit, so clear that
  cache after a release (BrutalSystems/muster#18)".
- `~/.cache/opencode/packages/@brutalsystems/tincan-opencode@latest/node_modules/@brutalsystems/tincan-opencode/package.json`
  → `"version": "0.7.2"`. *Confirmed* — that is what every muster-launched
  opencode 1.x session loads.
- BrutalSystems/muster#18 is "remote: nothing establishes whether two
  installations are compatible" — unrelated. The reference is stale (muster's
  repo was recreated and renumbered). No open issue in muster or tincan tracks
  the cache. *Confirmed.*
- opencode 2.x caches differently — `~/.cache/opencode/npm/<pkg>@latest/<timestamp>/`
  in the sandbox — which suggests it re-resolves; not verified.

## Findings

- *Confirmed:* opencode 1.x installs an npm plugin once into
  `packages/<pkg>@latest` and never checks for a newer version. Every
  session muster has launched since 0.7.2 ran 0.7.2 — missing every plugin
  fix since, including 0.9.0's acks and 2.x support.
- *Confirmed:* the muster config's issue reference is wrong.

## Options

1. **Clear the cache now and relaunch** `misty-comet`: delete
   `~/.cache/opencode/packages/@brutalsystems/tincan-opencode@latest`; the next
   opencode start re-downloads `@latest` (2.4.0). Restart the muster session.
2. **Make "update globally" clear it every time** — add the delete to the
   "...and update globally" steps in CLAUDE.md and RELEASING.md, so each cut
   on this machine refreshes the plugin with the CLI.
3. **Pin the version** in `~/.muster/config.toml` (`@2.4.0`), which changes
   the cache key; but it must be edited every release, and it is Mike's file.
4. File the cache problem properly (muster or tincan) and correct the
   muster config's reference.

Recommendation: 1 + 2, and 4 as a one-line issue.

## Decision

2026-10-07, Mike: options 1, 2 and 4 — with 4 as a correction to tincan's own docs (install.md claimed a specifier cannot go stale) rather than a separate issue. The wrong reference in `~/.muster/config.toml` is his file; reported, not edited.

## Next steps

Done: cache deleted; `misty-comet` stopped; relaunched as `curious-comet`
(`ses_ee85c3b52ffeARV9oDRiai1sq2`), record `plugin_version: 2.4.0`. Docs fixed
in the commit after `b18aba2`. Open: whether opencode 2.x re-resolves its
cache (its path carries a timestamp) — check after the next cut.
