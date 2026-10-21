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
  Ignore the descriptive slug, reject `@machine` addresses in this local-only
  version, and never fall back to display-name matching. An unidentified sender
  is quarantined even on runtimes whose existing send path permits missing IDs.
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
Neither a terminal check nor an agent-supplied flag proves operator identity.
Every retrieved peer envelope explicitly forbids running inbox administration
or inspecting quarantine in response to a peer request. `enable` accepts only
supported agent runtimes, never `external`.

The CLI uses the same policy and storage functions as MCP, with structured JSON
results and documented nonzero failure exits. No new CLI peer-query API is
needed. Update the existing design document to explain why explicit inbox
administration and retrieval are useful CLI exceptions.

## Retrieval contract

Expose `receive_peer_messages({cursor?, limit?})`. Resolve the caller using the
existing runtime-specific identity path, including Codex per-request metadata.
There is no receiver argument. Missing or ambiguous identity is an error.
An external process cannot invoke MCP retrieval as an agent. An identified
receiver without strict mode gets `{enabled:false, messages:[]}` and an
explanatory notice; a damaged policy is an error, not this disabled result.

For enabled receivers return `{enabled:true, messages, next_cursor, has_more}`.
Each item retains its message ID,
sender and receiver identities, timestamps, original envelope, reply correlation,
and explicit peer-origin/no-approval wording. Default limit is 20, maximum 100;
also cap each response to 1 MiB of serialized message data.

Cursors are opaque and bound to receiver identity and inbox generation. Empty
results preserve a valid cursor. Invalid, foreign, or obsolete cursors fail
explicitly. Reads are non-destructive: callers persist their returned cursor;
omitting it starts at the beginning of retained eligible content. Repeating a
read may return the same IDs. Do not automatically advance a server-side read
pointer: a committed advance followed by a lost response would hide messages.
The MCP tool description and CLI help must explicitly warn that cursor-less
polls return retained messages again, tell callers to pass `next_cursor` on the
next poll, and require deduplication by message ID rather than treating every
returned item as new.
Document saving the cursor in durable task state rather than conversation memory.
Fetch does not mean understanding, action, acknowledgement, or an answer.
Messages expire after a fixed 24 hours from insertion in version one; expired
content cannot be fetched even with an old cursor.

Each item is `quarantined`, `eligible`, or `released`. Assign a fresh monotonic
availability sequence when entering eligible or released, independent of insertion
order. A grant moves that sender's quarantined items to eligible; revoke moves
eligible items back to quarantine. Explicit per-message releases survive sender
revocation; use `drop` to withdraw them. Releasing a quarantined item does not
grant its sender. Visibility requires eligible/released state and sequence after
the cursor. Regranting can therefore return an earlier message ID again; consumers
dedupe by ID. No operation retracts text already fetched.

An idle session is not awakened. Its operator must arrange polling within an
active task or its existing orchestration loop. Urgent messages are stored with
their urgency metadata but do not cause a wake-up.

## Send and routing behavior

Resolve and verify target identity before consulting its strict policy. Check
strict routing before native liveness checks, legacy mailbox exceptions or
native delivery. A resolved, identity-verified strict target may accept queue
writes even when its harness is unreachable. An enabled
strict receiver always uses `method: pull-inbox`, including expected replies,
urgent messages, prefix matches, and external mailbox notifications.

Persist the original envelope once. Known permitted senders enter the available
queue; others enter quarantine. Return `outcome: accepted`, `method:
pull-inbox`, and structured `inbox_state: queued | quarantined` only after the
store commits. Acceptance means the store accepted responsibility, not that the
harness accepted or the agent read anything. Extend CLI JSON to retain these
fields instead of losing them in its current projection.
Set the envelope's method to `pull-inbox` before logging; log delivery as `queue`,
never `steer`, and retain urgency as metadata. `peers` exposes
`delivery: native | mailbox | pull` when known. Send notices explicitly say that
pull receivers collect on their own schedule and are not awakened.

Queue refusal is `rejected` with a machine-readable reason; storage or lock
failure is `failed`. Never call a runtime delivery adapter following either.
Preserve current size/rate guards, expected-recipient checks, reply IDs, and
fan-out validation. Preflight every broadcast destination before any write;
report individual outcomes if an actual write fails after preflight. Do not
promise transactional delivery across inboxes and native harnesses.
Preflight takes at most one receiver lock at a time; revalidate at each commit.
Do not hold multiple inbox locks to simulate a cross-transport transaction.

Version one uses existing peer discovery and does not resolve entirely absent
peers from inbox configuration. A discoverable but unreachable strict receiver
is different from an unresolvable address: the former can be queued, the latter
still fails resolution. Expected-recipient mismatch still rejects delivery.

Existing `replay_for_minutes` is log-based collection through
`message_log({missed:true})`, not automatic replay dispatch. Before any
`appendUnsent` call, inspect strict policy using both the resolved identity and
the intended ID (`expect_id`, when present). If either identifies a strict
receiver, log a fixed body placeholder and disable log-based replay; do not
enqueue an unresolvable or mismatched target. Inspect all runtime entries for a
bare intended ID, rather than guessing its runtime. If policy inspection cannot
complete, fail closed without writing a body. This applies to unknown, changed,
unreachable and preflight-refused targets, and ordinary/all-project log reads.
Return a notice explaining that a failed strict send was not saved for retrieval.

## Storage and failure behavior

Store versioned receiver directories under `$TINCAN_HOME/inboxes`, grouped by a
hash of the normalized full ID with a runtime subdirectory. The grouping supports
conservative bare-ID lookup; grants and retrieval still require runtime plus ID.
Use private directory/file permissions, validate ownership and reject symlinks.
The receiver directory itself is the persistent marker; one atomic state snapshot
contains policy, generation, grants and items. A missing or corrupt snapshot in
an existing receiver directory is an error, not ordinary delivery. Do not create
these directories during read-only lookup. If the root cannot be inspected, refuse delivery rather
than assuming no receiver has opted in. A genuinely absent root preserves the
legacy default. Explicit disable retains a disabled record; policy-file deletion
is not a supported way to disable strict mode.

Serialize each receiver's enable, disable, strict queue insertion, grant, revoke,
release, read and expiry operations with a cross-process lock. Revalidate policy
and generation under that lock before inserting. A send that selected strict
delivery cannot fall back to native delivery if the policy changes before commit;
return a policy-changed refusal instead. Native sends to receivers without strict
mode do not acquire an inbox lock, and no inbox lock is held across native
transport calls.

Enable applies to sends whose policy check observes the committed enabled state.
Policy checks starting after enable commits must observe it; do not use stale
policy caches. A send that selected native delivery before that commit may still
land afterward. `enable` and `status` must explain this in-flight exception.
Enabling cannot recall or drain already selected native sends. Locks live
separately from receiver marker directories, and lookup-only operations must not
accidentally enable strict mode.
Use atomic replacement for versioned state, commit
before success, and bounded lock waits. Do not reclaim a lock on age alone;
verify owner process lifetime or return a recoverable locked error. An uncertain
commit returns `outcome: failed`, `refusal: inbox_commit_unknown`, and its message
ID with an explicit warning that insertion may have occurred. Reconciliation is
by retrying the same supplied idempotency key and payload; `send_peer` has no
caller-supplied message-ID API. Without a key, report possible duplication and
do not recommend automatic retry. No outcome implies that a receiver read it.

Use a bounded atomic snapshot for the first version: maximum 500 items and
10 MiB serialized data per receiver, including quarantine. Reserve at least
80% of capacity for eligible messages so untrusted submissions cannot consume
the entire inbox. Reject newest items on capacity exhaustion; never evict an
unexpired accepted message silently. Expire and compact during operations.
Apply byte limits as well as the existing character limit.
The quarantine ceiling is 100 items and 2 MiB, within the total caps. Revocation
may exceed that quarantine ceiling by reclassifying already accepted items;
reject new quarantine submissions until usage falls below it. Grant/release never
increase total stored size beyond bounded metadata. Status reports retained item
and byte counts, eligible/quarantined/released counts, and next expiry. Fetch
does not free capacity; operators may explicitly drop items before expiry. Do not
infer successful receipt from a cursor to compact accepted bodies automatically.

A possible later extension is explicit acknowledgement of a previously returned
cursor, allowing acknowledged items to be compacted without advancing on fetch.
It is not part of version one. Its design must validate receiver and generation,
handle reissued availability sequences, and keep acknowledgement distinct from
understanding or answering. A lost fetch response would leave items unacknowledged
and available for retry. This could relieve capacity pressure without relying on
operator drops, but needs its own API and retention review.

Inbox message IDs and sender-scoped idempotency keys are checked within the
same transaction as insertion. Retain key records until message expiry. Do not
extend this stronger queue-specific deduplication claim to native delivery.
Resolve sender identity before the existing outer idempotency lookup. Namespace
that lookup and writes by runtime/full sender ID so shared MCP hosts cannot mix
thread keys. Missing IDs must not enter another agent's namespace. External
labels can namespace CLI retries but confer no grant authority. For strict sends,
the transactional store is authoritative across processes; an in-memory or CLI
key cache cannot substitute for it. A key reused with different payload or
recipient is rejected. Preserve native retry behavior within each sender's scope.

## Audit and quarantine visibility

The current global message log contains bodies and is readable through
`message_log`. Strict inbox content must not be copied there. Log metadata and
state transitions only for all strict inbox messages, with an explicit body
omission marker; the private inbox is the sole body store. Preserve the required
`text` string as `[body omitted: strict inbox]` and add `body_omitted: true`,
rather than removing `text` and breaking older readers. Preserve durable
from/to identities, reply IDs, answer assertions, broadcast IDs and expect-reply
metadata for routing and correlation. The historical `delivered` field means
store acceptance for `pull-inbox`, as it already does for `mailbox`; public
results continue to distinguish acceptance from reading. Ordinary agent log
queries must not provide an alternate path to held content. Operator quarantine
inspection is an explicit CLI action.

Log storage acceptance, quarantine, release, revocation and expiry separately.
Existing historical records remain readable; enabling strict mode does not
retroactively erase bodies already logged or fetched. Update the log's outdated
"nothing is held for an absent session" comment to distinguish audit history
from the new queue. Preserve the distinction between acceptance and an answering
reply. For strict replies, folding `answered` requires an original `answers:true`
assertion and evidence the answer entered eligible/released state. Quarantined,
failed and indeterminate replies cannot close a question. Grant/release can make
an existing answer assertion eligible but never manufacture one; fetch and cursor
changes never do so. Answered still does not mean read, and subsequent revocation
does not erase the historical fact that an answer was made available.
Logging failure cannot trigger a second delivery
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
types, and unsent/missed-log handling. Preserve legacy mail routing tests. Confirm
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
- Urgent, expected-reply, prefix, mailbox failure, broadcast and missed-log paths.
- Enable/native-send ordering, including permitted in-flight native completion
  and no inbox locks on native transport calls; strict unreachable receivers,
  bare-ID policy lookup,
  and quarantined answer assertions that must not mark a question answered.
- Quarantine bodies absent from agent-visible logs and all ordinary retrieval.
- MCP and CLI exercising the same store, including multi-request identity tests
  and opencode integration.

Run build, core/plugin tests, plugin typecheck and test typecheck before claiming
implementation complete. Use temporary state directories and fake runtime
adapters; no live permission settings or dialogs are changed by tests.

## Review decision

Peer review amendments: corrected missed-log handling and liveness ordering;
preserved log compatibility; specified missing identities, external/runtime
restrictions, per-item release semantics, capacity, and sender-scoped retry
behavior. Added transport visibility and a routing/enable concurrency boundary.
Follow-up review narrowed that boundary to policy-check ordering, avoiding lock
waits on ordinary native sends. Cursor-repeat guidance is mandatory in tool help;
explicit acknowledgement for capacity reclamation remains a possible extension.

Three suggestions are intentionally deferred or declined:

- Automatic server cursor advancement is declined because a lost response could
  skip messages. Non-destructive explicit cursors remain the first-version API.
- TTY checks are declined as an authorization mechanism. They obstruct scripted
  operators while agents can allocate terminals; the same-user trust limit is
  explicit instead.
- An opencode receiver-side socket guard is a valid possible extension, but is
  deferred. The current plugin has an injection point where it could refuse
  native sends, unlike the Claude/Codex adapters. Adding that guard would require
  deploying policy semantics into a separately packaged plugin and handling
  legacy wire identities; this version makes the same cooperating-sender promise
  across runtimes. No existing receiver-side enforcement is claimed.

Keep the current `receive_peer_messages` name and a directory marker with one
atomic snapshot. A policy file alone is insufficient if its absence silently
restores native delivery; an existing directory with missing state must fail.

Approve this design before writing the implementation plan. The principal scope
choice is intentional: identified agent senders work in the first release;
external supervisors require individual releases until separate credential
enrollment is designed. Publishing or changing the local installation is not
part of this design task.
