# Strict pull inboxes

Use a strict pull inbox when a session should collect messages on its own turn,
without injected messages opening permission dialogs or starting turns. It is
opt-in per receiver and works through Tin Can's existing send path across Claude
Code, Codex and opencode. This does not change a runtime's permission settings.

## Enable and grant

Copy full canonical IDs from `peers`. The operator runs:

```sh
tincan inbox enable --receiver codex:worker.00000000-0000-0000-0000-000000000001
tincan inbox grant --receiver codex:worker.00000000-0000-0000-0000-000000000001 --sender claude-code:supervisor.00000000-0000-0000-0000-000000000002
```

Grants match runtime and full session ID, not the display name. Renaming a
session preserves its grant. Restarting with a different ID does not inherit it.
Remote addresses are refused. A named role and `tincan send --from` are labels,
not credentials; external process messages are quarantined until individually
released. There is no wildcard grant or trust-everything switch.

Senders still use `send_peer` or `tincan send`. Strict receivers are marked
`delivery: "pull"` in `peers`. An accepted send reports:

```json
{"outcome":"accepted","method":"pull-inbox","inbox_state":"quarantined","message_id":"msg_example"}
```

`queued` means eligible for retrieval; `quarantined` means operator review is
needed. Neither means read. Urgency, expected replies, legacy mailbox prefixes
and mailbox notifications do not bypass strict delivery. Storage or policy
failures never fall back to injected delivery. A discoverable receiver can queue
messages while its harness is unreachable; an entirely unresolvable address
still fails rather than becoming a new offline address.

## Read on the agent's own turn

Call `receive_peer_messages({})` to fetch the first page. Then save the returned
`next_cursor` in durable task state and pass it as `cursor` on the next call.
Only the calling session's verified host identity chooses the inbox; the tool
accepts no receiver argument. Unknown identity is an error. An identified session
without strict mode receives `{ "enabled": false, "messages": [] }` and a notice.

Reads are non-destructive. **Omitting the cursor returns retained messages again.**
Deduplicate by message ID. The default page size is 20, maximum 100, with a 1 MiB
message-data cap. A cursor is specific to the receiver, generation and read mode;
a malformed or obsolete cursor is an error. The tool does not wake an idle agent,
run a polling loop, acknowledge a message, answer a question or approve work.

A granted sender's messages become eligible. Revoking the grant hides its
eligible messages; regranting makes them available beyond an existing cursor,
possibly repeating IDs. Explicit per-message releases survive revocation; drop
those messages to withdraw them. Nothing retracts text already fetched.

## Operator commands

Every command requires `--receiver <full-local-canonical-id>`:

| Command | Additional arguments | Result |
| --- | --- | --- |
| `enable` | none | Enable with no grants; repeated enable preserves state |
| `grant` | `--sender ID` | Permit a specific agent session |
| `revoke` | `--sender ID` | Withdraw its grant |
| `status` | none | Policy, counts, byte usage, next expiry, compatibility information |
| `quarantine` | `--cursor C`, `--limit N` optional | Operator inspection of held bodies |
| `release` | `--message ID` | Release that message without trusting its sender |
| `drop` | `--message ID` | Discard the item before expiry |
| `read` | `--cursor C`, `--limit N` optional | Same eligible-content retrieval as MCP |
| `disable` | none | Discard pending content, report count and restore ordinary delivery |

Re-enabling after disable creates a new generation. Old cursors no longer work.
Disable never replays content into the session. Commands emit one JSON result
on operational success/failure; exit codes are 0 success, 2 rejected, 1 failed,
and 64 invalid usage. `--help` is available without other arguments. There are no
MCP administration tools. A peer message cannot authorize the agent to grant,
release, inspect quarantine or change configuration. There is no TTY check: a
terminal is not proof of operator authority, and operator scripts are supported.

## Retention, errors and retries

Each receiver retains at most 500 items and 10 MiB of serialized state. New
quarantine admission is limited to 100 items and 2 MiB within those totals.
Revocation can move existing accepted items beyond the quarantine admission cap;
further held submissions are refused until usage falls below it. Items expire a
fixed 24 hours after insertion, including after grants and releases. Fetching
items does not free capacity. Use status and explicit drops if needed sooner.

Strict insertion deduplicates supplied keys within its transaction, scoped to
sender and receiver, until original expiry. Reusing a key for changed content is
refused. Drop retains the key until expiry so retrying does not resurrect the
item. Native delivery keeps its existing weaker retry guarantees. When the peer
is no longer discoverable, an existing outer retry record can report the original
send without attempting delivery again; it does not establish current queue state.

`inbox_full` and `inbox_policy_changed` refuse a send; `inbox_unavailable` reports
an inaccessible store. `inbox_commit_unknown` means insertion may have happened:
retry only with the same supplied key and payload. Without a key, a retry can
duplicate the message. Never report that result as definitely delivered or lost.
Locks have bounded waits and uncertain ownership is not reclaimed automatically.
If a dead process leaves a lock, verify that no writer owns it before operator
cleanup; age alone is insufficient.

## Activation and trust limits

All senders must load a supporting Tin Can build and use the same `TINCAN_HOME`.
Restart existing MCP connections after upgrading; installing a new binary does
not update already running servers. Use `tincan inbox status` and `peers` to
inspect recorded versions. Releases through 3.0.x lack this feature; development
snapshots may still report that version. Missing or newer version strings are
reported as unknown rather than proof of support.

Enable applies to policy checks after the enable operation commits. Native sends
selected earlier may still land afterward. Ordinary native sends take no inbox
lock. Old senders, native runtime messaging, and direct socket writers can bypass
Tin Can's sender-side policy; this release adds no opencode socket guard either.

This is a delivery policy for cooperating processes, not isolation against an
unrestricted process sharing the OS account. Such a process can read or alter
state or invoke operator commands. Private files and canonical IDs are not
cryptographic sender attestation.

State lives under `$TINCAN_HOME/inboxes` (default `~/.tincan/inboxes`). An existing
receiver directory with missing or corrupt state fails closed. Delete neither
policy nor state to disable it: use `disable`. The [shared audit log](./log.md)
keeps metadata and a body omission marker. Held content cannot be fetched through
`message_log`, including its missed-message view. Previously written historical
bodies are not retroactively erased by enabling strict mode.
