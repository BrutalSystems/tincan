# Live acceptance — SPEC §10

Verified target: **opencode 1.18.31**.

## Install

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
```

`tincan.ts` must sit **directly** in `plugin/` — the loader globs one level only,
so a nested `plugin/tincan/tincan.ts` would never load, while `plugin/tincan-lib/`
is correctly ignored.

## Checks

Record pass/fail for each. Do not mark the task complete with a failing row.

**Diagnostic surface:** The plugin's log is `~/.tincan/opencode-plugin.log`
(or `$TINCAN_HOME/opencode-plugin.log`). All `event=…` lines appear here, not in
opencode's own terminal or logs. This is where you will confirm delivery in
check 2 and search for message text in check 11.

1. **Registry file appears.** Start a plain `opencode`, send one message.
   A `~/.tincan/peers/opencode/ses_*.json` appears within a second, with `slug`
   populated and `state` set.

2. **Injection lands.** From another shell, with `SES` and `SOCK` taken from that
   file:
   ```
   python3 plugins/opencode/test/send.py "$SOCK" "$SES"
   ```
   The enveloped text appears in the session's context and the agent acts on it.
   
   **Confirming delivery:** Read the newest `[tincan] event=delivered` line from
   `~/.tincan/opencode-plugin.log` — this is the durable proof. Optionally, for
   byte-level proof, confirm the message is projected into the `session_message`
   table of `~/.local/share/opencode/opencode.db` (the older `message` table is
   a v1 projection and will NOT contain it; this check is read-only, for operators
   who want to verify at the SQLite level).

3. **State flips.** While the agent works, `state` reads `busy`; after it
   finishes, `idle`.

4. **Clean exit clears up.** Quit with `q`, then repeat and quit with ctrl-C.
   Both times the registry file and the socket are gone.

5. **`kill -9` leaves a refused socket.** Files remain, and
   `python3 plugins/opencode/test/send.py "$SOCK" "$SES"` fails with
   connection refused.

6. **Next start sweeps the orphan.** Start any new opencode instance; the files
   and socket left by check 5 are gone.

7. **Silent crash is swept too.** `opencode --continue`, do **not** type, then
   `kill -9`. A socket file remains with no `.json` beside it. Start a new
   instance; the socket is gone. (This is the case a record-driven sweep would
   miss.)

8. **`--continue` advertises nothing until active.** `opencode --continue` and do
   not type: no registry file. Expected behaviour per SPEC §5, not a bug.

9. **…then it appears.** Send one message in that resumed session; the registry
   file appears and is correct.

10. **Socket permissions.** `stat -f %Sp` on the socket reads `srw-------`, and
    `stat -f %Sp` on `~/.tincan/peers/opencode` reads `drwx------`.

11. **No message text in logs.** Search `~/.tincan/opencode-plugin.log` for
    the string `GOLDFISH` (from check 2's default envelope). No match. (Opencode's
    own log is also searched to confirm the message text does not leak there either.)

12. **Caller identity.** With Tin Can registered as an MCP server in this
    opencode (see the Change Notice §5), invoke any Tin Can tool from the
    session. `~/.tincan/peers/opencode/inst-*.caller.json` appears, its
    `session_id` matches the session that made the call, and its `pid` is the
    opencode process. Quit; the file is gone.
