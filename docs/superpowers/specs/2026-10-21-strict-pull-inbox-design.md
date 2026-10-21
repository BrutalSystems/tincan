# Strict pull inbox with operator grants

Status: proposed design; scope approved, implementation not started.

## Purpose

An operator can configure an agent session to collect peer messages on its own
turn without an injected message opening a permission dialog or starting a new
turn. This is a general, same-machine Tin Can feature across supported runtimes.
It does not depend on a particular supervisor or agent orchestration product.

Success means eligible messages are durably queued for explicit retrieval,
unlisted senders remain quarantined, and no error or message attribute changes
strict pull delivery into native push. Existing installations retain their
current behavior until explicitly configured.

## Approach and alternatives

Use a built-in local queue and receiver policy, sharing the existing send
pipeline and envelope. Keep legacy external mailbox routing unchanged for
receivers that have not enabled strict pull.

Extending only the external inbox-command adapter would leave storage, grants,
retrieval, and quarantine semantics different in every installation. Existing
mail routing also deliberately falls back to native delivery. It is not an
appropriate enforcement layer for this feature.

Native permission-mode attestation and channel push remain separate research.
Neither is needed for pull, and permission class is not a sender grant.

## First-version boundary

- Grants cover identified agent sessions: runtime plus full durable session or
  thread ID, using existing canonical address parsing and identity rules.
- Display names, working directories, message prefixes, and claimed roles are
  never grant keys. Renaming a session preserves its grant; a replacement
  session with the same name does not inherit it.
- External CLI senders may submit to quarantine. Their `--from` labels cannot
  receive grants. Operator release of an individual message is supported.
  Credential enrollment for unattended external supervisors is deferred.
- No role registry, background polling daemon, network listener, or automatic
  session launcher is introduced.
- No global accept setting, dialog automation, child-process relay, permission
  relay, or notification injection is introduced.

## Operator interface

Add `tincan inbox` subcommands. All state-changing commands require an exact
canonical receiver address; interactive shorthand resolution is not included.

| Command | Behavior |
| --- | --- |
| `enable --receiver ID` | Create an empty strict policy and inbox |
| `grant --receiver ID --sender ID` | Permit an identified session's messages |
| `revoke --receiver ID --sender ID` | Remove permission for future retrieval |
| `status --receiver ID` | Show policy, queue counts, expiry and runtime requirements |
| `quarantine --receiver ID` | Operator-only CLI view of held messages |
| `release --receiver ID --message ID` | Release one held message without granting its sender |
| `drop --receiver ID --message ID` | Discard one queued or held message |
| `read --receiver ID [--cursor C] [--limit N]` | Explicit operator CLI equivalent of retrieval |
| `disable --receiver ID` | Explicitly restore ordinary delivery; discard pending items |

Disable reports discard counts and never replays pending content into the
harness. Enabling again creates a new inbox generation, invalidating old
cursors. Management commands are not MCP tools. Agents are instructed never to
execute them because a peer message requests a policy change. CLI access is
operator authority, not a claim that arbitrary same-user shell access is safe.

The CLI uses the same policy and storage functions as MCP, with structured JSON
results and documented nonzero failure exits. No new CLI peer-query API is
needed. Update the existing design document to explain why explicit inbox
administration and retrieval are useful CLI exceptions.

## Retrieval contract

Expose `receive_peer_messages({cursor?, limit?})`. Resolve the caller using the
existing runtime-specific identity path, including Codex per-request metadata.
There is no receiver argument. Missing or ambiguous identity is an error.

Return `{messages, next_cursor, has_more}`. Each item retains its message ID,
sender and receiver identities, timestamps, original envelope, reply correlation,
and explicit peer-origin/no-approval wording. Default limit is 20, maximum 100;
also cap each response to 1 MiB of serialized message data.

Cursors are opaque and bound to receiver identity and inbox generation. Empty
results preserve a valid cursor. Invalid, foreign, or obsolete cursors fail
explicitly. Reads are non-destructive: callers persist their returned cursor;
repeating a read may return the same IDs. Fetch does not mean understanding,
action, acknowledgement, or an answer. Messages expire after 24 hours by
default; expired content cannot be fetched even with an old cursor.

Maintain a monotonic availability sequence independent of insertion order.
Granting a sender or releasing an item makes newly eligible messages appear
after the reader's existing cursor. Revocation removes unread and retained
messages from ordinary retrieval immediately; regranting reissues availability
sequence positions, so a consumer may see an earlier ID again. Consumers dedupe
by message ID. Revocation cannot retract text already fetched.

An idle session is not awakened. Its operator must arrange polling within an
active task or its existing orchestration loop. Urgent messages are stored with
their urgency metadata but do not cause a wake-up.

## Send and routing behavior

Resolve and verify target identity before consulting its strict policy. Check
strict routing before legacy mailbox exceptions or native delivery. An enabled
strict receiver always uses `method: pull-inbox`, including expected replies,
urgent messages, prefix matches, and external mailbox notifications.

Persist the original envelope once. Known permitted senders enter the available
queue; others enter quarantine. Return `outcome: accepted`, `method:
pull-inbox`, and structured `inbox_state: queued | quarantined` only after the
store commits. Acceptance means the store accepted responsibility, not that the
harness accepted or the agent read anything. Extend CLI JSON to retain these
fields instead of losing them in its current projection.

Queue refusal is `rejected` with a machine-readable reason; storage or lock
failure is `failed`. Never call a runtime delivery adapter following either.
Preserve current size/rate guards, expected-recipient checks, reply IDs, and
fan-out validation. Preflight every broadcast destination before any write;
report individual outcomes if an actual write fails after preflight. Do not
promise transactional delivery across inboxes and native harnesses.

Version one continues to use existing live-peer discovery. Strict pull does not
create a new offline addressing service. If existing replay offers a message
later, it must re-check current strict policy and grants through the same router;
it must never replay directly into a strict receiver's harness.

## Storage and failure behavior

Store versioned receiver directories under `$TINCAN_HOME/inboxes`, keyed by a
hash of normalized runtime/full ID. Use private directory/file permissions,
validate ownership and reject symlinks. Keep a persistent strict marker separate
from policy data. Missing or corrupt policy behind a marker is an error, not
ordinary delivery. If the inbox root cannot be inspected, refuse delivery rather
than assuming no receiver has opted in. A genuinely absent root preserves the
legacy default. Explicit disable retains a disabled record; policy-file deletion
is not a supported way to disable strict mode.

Serialize each receiver's send, grant, revoke, release, read and expiry operations
with a cross-process lock. Use atomic replacement for versioned state, commit
before success, and bounded lock waits. Do not reclaim a lock on age alone;
verify owner process lifetime or return a recoverable locked error. An uncertain
commit returns an indeterminate result with its message ID; retries reconcile
against that ID or a supplied idempotency key.

Use a bounded atomic snapshot for the first version: maximum 500 items and
10 MiB serialized data per receiver, including quarantine. Reserve at least
80% of capacity for eligible messages so untrusted submissions cannot consume
the entire inbox. Reject newest items on capacity exhaustion; never evict an
unexpired accepted message silently. Expire and compact during operations.
Apply byte limits as well as the existing character limit.

Inbox message IDs and sender-scoped idempotency keys are checked within the
same transaction as insertion. Retain key records until message expiry. Do not
extend this stronger queue-specific deduplication claim to native delivery.

## Audit and quarantine visibility

The current global message log contains bodies and is readable through
`message_log`. Strict inbox content must not be copied there. Log metadata and
state transitions only for all strict inbox messages, with an explicit body
omission marker; the private inbox is the sole body store. Ordinary agent log
queries must not provide an alternate path to held content. Operator quarantine
inspection is an explicit CLI action.

Log storage acceptance, quarantine, release, revocation and expiry separately.
Existing historical records remain readable. Preserve the distinction between
acceptance and an answering reply; a grant, release, cursor, or fetch cannot
close an outstanding question. Logging failure cannot trigger a second delivery
after a successful queue commit; the inbox transaction remains authoritative.

## Compatibility and trust limits

This is delivery policy for cooperating local Tin Can processes, not a sandbox
against unrestricted processes sharing the OS account. Such processes can read
or alter files or use another transport. Private files and canonical IDs do not
constitute cryptographic sender attestation.

All sending Tin Can instances must load the supporting release and share the
same state root before relying on strict mode. Older instances, native runtime
messaging, and direct socket writers bypass this router. Enabling/status must
explain that limitation and report incompatible discovered instances where
version information is available. No claim that Tin Can controls every inbound
path is permitted. Policy changes never modify Claude Code's native settings.

## Implementation boundaries and verification

Add focused modules for policy/store operations and inbox CLI parsing; integrate
through `tools.ts`, `runtime.ts`, `tincan.ts`, tool definitions, envelope/log
types, and the existing replay path. Preserve legacy mail routing tests. Confirm
the opencode host exposes the retrieval tool using its established caller
identity mechanism. Update public tool, CLI, log, design, install and
troubleshooting documentation with generic examples.

Write failing tests before implementation. Required coverage includes:

- Granted, quarantined, revoked, regranted and individually released messages.
- Runtime/full-ID matching, renamed sessions, replacement sessions, ambiguous
  caller identity, and external label spoofing.
- Cursor pagination, release after cursor advancement, repeated reads, expiry,
  generation changes and receiver isolation.
- Concurrent writers, capacity reservation, retry deduplication, atomic write
  failure, corruption and lock recovery; no native delivery on any strict path.
- Urgent, expected-reply, prefix, mailbox failure, broadcast and replay paths.
- Quarantine bodies absent from agent-visible logs and all ordinary retrieval.
- MCP and CLI exercising the same store, including multi-request identity tests
  and opencode integration.

Run build, core/plugin tests, plugin typecheck and test typecheck before claiming
implementation complete. Use temporary state directories and fake runtime
adapters; no live permission settings or dialogs are changed by tests.

## Review decision

Approve this design before writing the implementation plan. The principal scope
choice is intentional: identified agent senders work in the first release;
external supervisors require individual releases until separate credential
enrollment is designed. Publishing or changing the local installation is not
part of this design task.
