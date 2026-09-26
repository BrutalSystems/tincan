# Sending from outside a session

`tincan send` is the one part of Tin Can reachable without an agent
harness. Everything else is an MCP tool; see [Tools](./tools.md).

## Sending from outside a session

`tincan send` delivers one message to one peer from a process that is **not** an
agent session — a shell, a cron job, a Go binary. It reaches all three runtimes,
exactly as the MCP tool does, because it *is* the MCP tool's code path with a
different caller.

```console
$ tincan send --to muster-59 --from birddog --message 'disk 91% on st-eks'
{"outcome":"accepted","message_id":"msg_9f2e…","peer_state":"busy"}
```

| Flag | |
|---|---|
| `--to` | the peer, spelled as `peers` names it |
| `--from` | who is sending. Lowercase letters, digits and single hyphens |
| `--message` | the text to deliver |
| `--idempotency-key` | a later retry under the same key will not send twice |
| `--reply-via` | how to answer, for a sender that has no inbox |

**One line of JSON on stdout, on every exit code — including the failures.**
`{outcome, refusal, message_id, peer_state}`, with absent fields omitted rather
than null. Diagnostics go to stderr, so a caller can parse stdout whole without
scanning it. If JSON appeared only on success, a caller could not separate
`peer_unknown` — go and look at your configuration — from `delivery_failed`, a
transport fault worth retrying, and those want opposite responses.

**Read `refusal`, not the exit code.** The refusal vocabulary is wider than the
useful exit space and grows. The codes exist so that `tincan send … || …` means
something: `0` accepted, `2` rejected, `1` failed, `64` a malformed command line.
`64` is deliberately outside the outcome codes — nothing was attempted, there is
no `message_id`, and no refusal describes it, so a caller must not read it as a
peer problem and retry.

**`accepted` means the peer's harness took the message — not that it was read,
and not that it will be acted on.** This is the same ceiling `send_peer` reports
and it will not be raised later: "held for a busy peer" and "delivered" are one
outcome here, because Tin Can never establishes that anything was read. Where the
peer stood at send time is in `peer_state`, which is an observation about the
peer, not a claim about the message.

**`--from` is refused, never repaired.** It becomes the envelope's `from=`, and a
peer listing slugifies every name it shows — so a name that is not already
slug-shaped is an address nobody can type back. That was issue #40 on the Claude
arm, where a session called `Auth Refactor` announced a name `resolvePeer` then
refused. Rewriting it here would reproduce that silently: recipients would see a
name the sender never chose. So `tincan send --from 'Bird Dog'` fails and names
`bird-dog` as the value that would work.

**A CLI sender cannot be replied to**, and the message says so rather than
letting a recipient try. It has no harness, so it has no inbox, no registration
and no durable id — and the envelope omits `canonical_id` rather than
half-building an address that cannot round-trip. Because "you cannot reply" is
unhelpful on its own, `--reply-via` carries the route the sender does answer on:

```console
$ tincan send --to muster-59 --from birddog --message 'disk 91%' \
    --reply-via 'birddog ack --instance bd-8bcbebb485fa --incident 7'
```

Note that this is the one place Tin Can names a sender that is not a session;
`peers` never lists one, because nothing can deliver *to* it.

**Retries.** `--idempotency-key` distinguishes the two cases a caller must not
confuse, in `refusal` rather than in prose:

| `refusal` | meaning |
|---|---|
| `duplicate_send` | same key, same peer, same text, **and the name still resolves to the session that received it**. The message was sent and `message_id` names it. A retry may treat this as success |
| `duplicate_peer_moved` | same key and text, but that name now resolves to a **different session** than the one reached. The earlier send stands; the peer you are addressing now has not received it, and Tin Can will not claim otherwise |
| `key_reused` | same key, different peer or text. **Nothing was sent** — the key is spent and this is a caller bug |

Both arrive as `rejected`, and both name a `message_id` — under `duplicate_send`
it is your message; under `key_reused` it is the unrelated message the key
belongs to, which is what you need to find the bug.

Keys on this path are **held on disk** for the same ten-minute window the tool
uses, under `send-keys/` beside the message log, because a CLI invocation is a
whole process: the in-memory store every hosted Tin Can uses is written and then
never read, so the flag did nothing at all until this was added. Hosted Tin Can
deliberately keeps the in-memory store — making keys durable there would
strengthen a guarantee its callers were told not to rely on, invisibly to all of
them.

What that window does and does not promise, stated plainly because the
neighbouring guarantees are:

- **A later retry is deduplicated**, across processes. That is the case the flag
  exists for.
- **Two invocations racing each other are not.** Both can find no record and both
  send. Closing that needs the key reserved *before* delivery, and a reservation
  is the thing that must not be taken: a crash between reserving and sending
  would burn the key and turn one transient failure into a permanent refusal.
  A narrower race is not worth a worse failure, which is the same trade the
  in-memory store already makes.
- **It is not exactly-once**, and a key that ages out of the window and is reused
  will deliver again.

A send that never landed does **not** burn its key — retrying under the same key
after a failure is the correct response and it works.

`duplicate_peer_moved` exists because a key identifies an intent, and the intent
includes *who*. The comparison would otherwise be the address string and the
text, neither of which names the session that received anything — so a name
moving to a new session inside the window would turn a retry into "already
sent" about a session that never got the message. Names do move here; that is
what [Peer names](./peers.md#peer-names) is about. The recorded durable id is the one part
of the intent that cannot be reassigned to somebody else.

## Asking whether this tincan can send

```bash
tincan send --help    # exits 0 here; exits non-zero on any build without `send`
```

Use the **exit code**, not the output. A build that predates the subcommand
treats `send` itself as an unrecognised argument and exits non-zero, so a zero
exit is a capability answer. The alternative — matching the wording of an error
message — depends on prose nobody promised to keep, and a reword would silently
start accepting a tincan that cannot deliver.

Do not use `--version` for this. It couples a caller to version semantics for a
question the binary can answer about itself.
