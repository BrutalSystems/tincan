# Tin Can — opencode Plugin

## What it does

This plugin makes live opencode sessions addressable as peers in Tin Can's messaging network. When installed, any active opencode session automatically advertises itself to the registry at `~/.tincan/peers/opencode/`, where Tin Can can discover and send messages to it. Without this plugin, there are no opencode peers — a session running in the TUI is invisible to peer messaging, even if Tin Can is installed.

The plugin receives inbound messages delivered to a Unix socket and injects them into the active session as prompts for the agent to act on.

## Requirements

- **opencode** 1.18.31 (verified; other versions untested)
- **Tin Can** 0.4.0 or later

## Install

The loader globs one level deep, so the installation is two copies:

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
```

### Why two copies?

The opencode loader globs `{plugin,plugins}/*.{ts,js}` — one level deep only. `tincan.ts` must sit directly in `~/.config/opencode/plugin/`, or the plugin will not load at all.

The `tincan-lib/` directory contains unit-testable helpers and is never globbed by the loader, which is exactly what we want. It is namespace-separated (not called `lib/`) because `~/.config/opencode/plugin/` is shared with every other opencode plugin, and we need the name to be unambiguous.

Note: `~/.config/opencode/plugins/` (plural) is equally valid — both spellings work.

## Verify the installation

1. Start opencode normally:
   ```bash
   opencode
   ```

2. Within the TUI, send a message (type a message and press Enter — any input to the agent is fine).

3. Check the registry in another terminal:
   ```bash
   ls -la ~/.tincan/peers/opencode/
   ```

   You should see:
   - Session files named like `ses_*.json`
   - An instance socket named like `inst-*.sock` (mode `0600`)
   - An instance caller file named like `inst-*.caller.json`

4. Examine a session file:
   ```bash
   cat ~/.tincan/peers/opencode/ses_*.json
   ```

   It should contain the session ID, slug, title, directory, state, and socket path.

## Uninstall

Remove the plugin files:

```bash
rm ~/.config/opencode/plugin/tincan.ts
rm -rf ~/.config/opencode/plugin/tincan-lib
```

Clean up the registry (this step is optional but recommended):

```bash
rm -rf ~/.tincan/peers/opencode
rm -f ~/.tincan/opencode-plugin.log
```

## Troubleshooting

The plugin log is the only diagnostic surface. Output does not reach opencode's own log file; check this file instead:

```bash
tail -f ~/.tincan/opencode-plugin.log
```

Or with a custom `TINCAN_HOME`:

```bash
tail -f "$TINCAN_HOME/opencode-plugin.log"
```

### Troubleshooting table

| Symptom | Cause | Action |
|---------|-------|--------|
| **No registry files appear at all** | The plugin is not loading, or initialization failed. | Check the plugin log for `event=selfcheck.failed`. This usually means opencode's private `client._client` field moved due to a version change. Only opencode 1.18.31 is verified. See SPEC.md §3. |
| **No file appears after `opencode --continue`** | Expected, not a bug. A resumed session is invisible until it next does something. | Send one message to the session (type input or wait for agent activity). The registry file will appear then. See SPEC.md §5. |
| **`event=bind.failed` mentioning socket path too long** | `TINCAN_HOME` directory nesting is too deep. macOS caps AF_UNIX socket paths near 103 bytes. | Shorten `TINCAN_HOME` or the path to it. For example, move `~/.tincan` to a shallower location. |
| **Messages accepted but nothing happens; `event=transport-broken detail=html response`** | The `/api/` prefix was lost in the request path. The opencode server falls back to its web UI and returns 200 with HTML instead of JSON, making an invalid request look like success. | Verify you are running opencode 1.18.31. Check the plugin source to ensure `POST /api/session/{sessionID}/prompt` is the exact path. |
| **`event=rejected status=409`** | The same `message_id` was re-sent with different content. opencode treats this as a mismatched re-submit. | This is not a retryable failure. Check the Tin Can side to ensure message IDs are not being duplicated. |
| **`event=dropped detail="missing envelope"`** | The `text` on the wire did not carry Tin Can's `<peer_message …>` envelope. | The envelope is the only thing marking an injected prompt as a peer's words rather than the operator's, so the plugin requires it. A hand-rolled sender must include it; from Tin Can itself this means a bug on the sending side. See SPEC.md §7. |
| **`event=dropped detail=unknown session`** | A message arrived for a session ID this plugin never heard announced. | Expected right after `opencode --continue` if messages arrive before the session is active. Send the message again; the session will be registered on its next activity. |
| **Stale peers listed in Tin Can, or socket files remain after a crash** | An instance was killed with `kill -9` or crashed without cleanup. Its registry files and socket remain. | Start a fresh opencode instance. On startup, the plugin sweeps orphaned sockets and removes any files for dead processes (identified by attempting a connection and seeing it refused). This is automatic. |

## Known limits

1. **Replay detection is per-process.** After an opencode restart, a re-sent `message_id` is logged as a fresh delivery even though opencode still de-duplicates it server-side. The plugin's log wording is approximate; the actual behaviour (no duplicate injection) is guaranteed.

2. **The plugin log has no rotation.** It grows for the life of the install. You may want to periodically truncate it or move it to a separate logging pipeline.

3. **A resumed session is invisible until active.** When you run `opencode --continue`, the session does not appear in the registry until it next receives an event (a message, a user action, or agent activity). This was chosen over guessing from a session list, which would advertise closed sessions and silently lose messages. See SPEC.md §5 for details.

## What it deliberately does not do

### No outbound send path

This plugin only *receives* messages. For opencode to *send* messages to a peer, Tin Can must be registered as an MCP server in opencode's configuration and accessed as a tool. The plugin and the MCP server are separate installations and work in tandem.

**Both are needed for two-way messaging.** Installing only the plugin gives you a peer that can listen but not speak. Installing only Tin Can as an MCP server gives you a peer that can speak but not listen. No error is raised either way — you just get one-way silence.

### No rate limiting

Rate limiting is Tin Can's responsibility, not the plugin's. The plugin injects every message it receives immediately. If a flood arrives, Tin Can is at fault.

### No message logging

The plugin logs sender, session, delivery mode, and message ID for diagnostics, but it does not log message bodies. The user's work is recorded in Tin Can's own logs; duplicating it here would clutter the plugin log.

### No `/tui/append-prompt` integration

Putting text in the human's compose box (the `/tui/append-prompt` endpoint) would interrupt a person rather than an agent. This is a different product decision that belongs in a later conversation about operator notification and workflow, not in the peer-messaging path.

See SPEC.md §11 for more details on out-of-scope features.
