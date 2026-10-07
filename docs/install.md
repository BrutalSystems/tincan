# Install

Installing the binary for each runtime, the opencode plugin, and the
environment variables that affect it.

## Install

```bash
npm install -g @brutalsystems/tincan
```

**Updating.** Publishing a new version does not touch an installed copy —
`tincan --version` keeps reporting the old one until you pull it:

```bash
npm update -g @brutalsystems/tincan
tincan --version
```

If `which tincan` points at a version manager's shim (`~/.asdf/shims/tincan`,
for instance), run the update under the node version that shim resolves to,
and reshim afterwards — `asdf reshim nodejs`. **Then restart your sessions:**
MCP servers are started once at session startup, so a session running the old
binary keeps running it until it restarts. Sessions pointed at a working copy
rather than the global install are already current.

**Install it on every side you want addressable.** A session can only be
*reached* if it has Tin Can too, so register it with each runtime you want to
talk to. None of the references below need a path — the `tincan` command is on
`PATH` once installed.

**Claude Code** (user scope, so it works in every project):

```bash
claude mcp add -s user tincan -- tincan
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.tincan]
command = "tincan"
tool_timeout_sec = 30
```

Restart each session to pick it up — MCP servers are loaded at startup.

**opencode** needs two separate installs, not one, and it is the runtime where
doing only half of it is easy to do by accident. Do both, in order:

1. **Register Tin Can as an MCP server.** This is the *send* half — it is how
   an opencode session reaches anyone else. In
   `~/.config/opencode/opencode.json` (or a project-level `opencode.json`):

   ```jsonc
   {
     "mcp": {
       "tincan": {
         "type": "local",
         "command": ["tincan"],
         "enabled": true
       }
     }
   }
   ```

   Without this, the session has no `peers`, `send_peer` or `message_log`
   tools at all — it can be messaged, but it cannot message anyone.

   **opencode 2.x** reads MCP servers from `mcp.servers`, one level down:

   ```jsonc
   {
     "mcp": {
       "servers": {
         "tincan": { "type": "local", "command": ["tincan"] }
       }
     }
   }
   ```

   The 1.x shape above is **ignored on 2.x without any error** — `opencode mcp
   list` says "No MCP servers configured" — so check with that command after
   editing. 2.x's default code mode, which offers tools to the model inside a
   generic `execute` tool rather than one by one, works with Tin Can as is.
   Sending from a 2.x session needs Tin Can **2.3.1 or later**: earlier
   versions could not tell they were running under opencode 2.x and refused
   every send with `peer_unknown`. Verified end to end on 2.0.24, both
   directions between two 2.x sessions.

> **Upgrading from 0.5.x?** The plugin is copied to disk, so `npm update -g`
> does **not** update it. Re-run the copy below after every upgrade. 0.6.0
> changed the endpoint the plugin posts to, and an 0.5.x plugin left in place
> will keep using the route that does not run your messages.

2. **Install the plugin.** This is the *receive* half — it is what makes an
   opencode session show up in anyone else's `peers` list at all:

   ```bash
   PKG="$(npm root -g)/@brutalsystems/tincan"
   mkdir -p ~/.config/opencode/plugin
   cp "$PKG/plugins/opencode/tincan.ts" ~/.config/opencode/plugin/
   cp -r "$PKG/plugins/opencode/tincan-lib" ~/.config/opencode/plugin/
   ```

   `tincan.ts` must sit **directly** in `plugin/` — opencode's loader globs one
   level only, so a nested `plugin/tincan/tincan.ts` never loads. The same two
   copies serve opencode 1.x and 2.x: one file carries both plugin APIs
   (2.3.0 and later; earlier copies fail to load on 2.x, #46).
   `plugin/tincan-lib/` holds the plugin's actual logic; the loader correctly
   ignores it, so leave it where it lands. (`~/.config/opencode/plugins/`,
   plural, works identically if that is what you already use.)

3. **Restart opencode.** Both the MCP registration and the plugin load only at
   startup.

4. **Check which plugin actually loaded.** This is the one step people skip,
   and it is the one that would have caught a stale plugin sitting on disk
   through five releases:

   ```bash
   cat ~/.tincan/peers/opencode/ses_*.json | grep plugin_version
   ```

   Every live opencode session writes a record there. If `plugin_version` is
   older than the `tincan` binary's own `--version`, the copy in step 2 did
   not happen or the session predates it. No error appears anywhere else —
   the session simply never answers peer messages.

#### Installing the plugin from npm (preferred)

The plugin is published on its own as
[`@brutalsystems/tincan-opencode`](https://www.npmjs.com/package/@brutalsystems/tincan-opencode),
at the same version as the server. opencode installs plugins by npm specifier,
which removes the copy step in step 2 — and the staleness with it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@brutalsystems/tincan-opencode"]
}
```

**Prefer this over the hand copy.** A copied file goes stale in silence —
nothing updates a copy, and a 0.4.0 plugin sat on one machine through five
releases still posting to a route that does not run messages. A specifier has
no copy to go stale.

Verified end to end on 0.6.2: opencode resolves and installs the package,
executes it, and the session registers, receives a peer message and replies —
with nothing hand-copied anywhere.

Whichever you use, run step 4 afterwards. An unloaded plugin looks exactly
like no plugin at all.

> **If you publish an opencode plugin yourself, read this.** 0.6.1 was fetched
> and never executed — no error, no log line, indistinguishable from not
> configuring it. opencode's loader
> (`packages/opencode/src/plugin/shared.ts`, `resolvePackageEntrypoint`) reads
> `exports["./server"]`, then falls back to `main`. It never reads
> `exports["."]`, which was all 0.6.1 declared, so the entry resolved to
> nothing. Declare `exports["./server"]` and `main`. If a specifier-named
> plugin of yours silently does nothing, check that before looking anywhere
> else.

#### Choosing an install shape

Both halves can come from npm, or from disk. The trade-offs:

| | Pro | Con |
|---|---|---|
| **MCP** via global install (`tincan`) | fast session start; `npm update -g` keeps it current | has to be installed |
| **MCP** via `npx -y @brutalsystems/tincan` | nothing installed; cannot go stale | re-resolves every session start — latency and a network dependency each launch |
| **Plugin** via npm specifier | opencode keeps it current; no copy to go stale | needs opencode 1.18.x or newer |
| **Plugin** via hand copy | works without npm resolution | nothing updates a copy — the failure above |

For daily use the global install plus the npm specifier is the combination
with no stale-copy failure mode and no per-launch cost. `npx` suits a trial.
Under [Muster](https://github.com/BrutalSystems/muster) neither applies: see
below.

If you launch opencode through [Muster](https://github.com/BrutalSystems/muster),
neither applies: `muster run opencode --plugin tincan` injects the plugin per
launch from a path in Muster's own config, so nothing is installed globally.

**Both installs are required for two-way messaging, and each one fails
silently without the other** — no error appears in either session:

| Installed | Missing | Result |
|---|---|---|
| MCP registration | Plugin | This session can send — `peers` and `send_peer` work — but no other runtime's `peers` ever lists it. It can talk, not listen. |
| Plugin | MCP registration | Other runtimes can see and message this session, but it has no Tin Can tools of its own to reply with. It can listen, not talk. |

If a peer you expect is missing, or a tool you expect is absent, check which
half is actually installed before assuming Tin Can is broken.

To try Claude Code or Codex without installing, substitute `npx -y
@brutalsystems/tincan` for `tincan` in either config above; the same
substitution works for opencode's MCP `command`
(`["npx", "-y", "@brutalsystems/tincan"]`). That re-resolves the package on
every session start, so it is better for a trial than for daily use. The
plugin half still needs real files on disk, though — `npx` fetches nothing you
can `cp` from, so use a clone (below) or a one-off `npm install -g` for that
one step.

<details>
<summary>Running from a clone instead</summary>

```bash
npm install && npm run build
claude mcp add -s user tincan -- node /abs/path/to/tincan/dist/tincan.js
```

```toml
[mcp_servers.tincan]
command = "node"
args = ["/abs/path/to/tincan/dist/tincan.js"]
tool_timeout_sec = 30
```

```jsonc
{
  "mcp": {
    "tincan": {
      "type": "local",
      "command": ["node", "/abs/path/to/tincan/dist/tincan.js"],
      "enabled": true
    }
  }
}
```

The plugin copies straight from the clone instead of the global install:

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
```

</details>

### Environment

- `TINCAN_HOME` — where the log lives, and where the opencode plugin keeps its
  own registry and log. Default `~/.tincan`.
- `CODEX_HOME` — honoured for locating Codex state. Default `~/.codex`.

## Prerequisites

**Claude Code 2.1.224+** (verified against **2.1.267**). Each session publishes
an inbox socket and a registry entry under `~/.claude/sessions/`; both are
created automatically.

**Codex CLI on `PATH`** (verified against **codex-cli 0.155.1**). No app-server
daemon and no control socket are required — see
[Codex: no daemon required](./how-it-works.md#codex-no-daemon-required).

**opencode 1.18.31** (fully verified) or **1.18.32** (transport contract
re-verified; see the plugin SPEC §3), **with the plugin
installed** — an opencode session with only the MCP registration is invisible
to every other peer's `peers` list. See [Install](#install) and
[opencode: inverted reach](./how-it-works.md#opencode-inverted-reach).

**Node 22 or newer**, for the `tincan` process itself.
