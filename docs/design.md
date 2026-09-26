# Design decisions and limits

What Tin Can deliberately does not do, and the bounds it works within.
Each of these was considered and decided rather than left undone.

## Deliberately not included

These are decisions, not gaps. Each was considered and declined for a reason.

**No CLI *query* surface.** A `tincan peers --json` command was proposed so
another tool's contract test could cross a process boundary; it was dropped,
because a test-only command is a second code path that can pass while the real
one breaks — precisely the drift such a test exists to catch. A test can speak
MCP over stdio to the installed binary in about forty lines, and gets a stronger
guarantee for it. That still holds, and there is still no `tincan peers`.

This entry used to read "No CLI", and said that if one were ever added it should
be read-only. [`tincan send`](./send-cli.md#sending-from-outside-a-session) is the exception
that was worth making, and it is worth being precise about why, because it is
write-only — the opposite of what that sentence anticipated.

The declined proposal was a *second path to something MCP already reached*. A
harness-less caller is not that: a program with no agent harness has nothing to
host a stdio MCP server, so for it the doorway is not inconvenient, it is shut.
The concrete cost of leaving it shut was birddog reimplementing Claude Code's
unpublished inbox wire format in a second repository, pinned to one Claude
version — the same fragile interface maintained twice, breaking in two places at
once.

And the drift argument does not transfer, because `send` is not a second path.
It resolves addresses, applies the guards and writes the log by calling the same
`send_peer` the MCP tool calls, through the same seam; what differs is only who
is sending. There is nothing here that can pass while the real one breaks,
because it is the real one.

**Tin Can never spawns a session.** Launching an agent is a privilege-escalation
primitive: it creates a new process with its own permissions and sandbox, in a
directory of the caller's choosing. Tin Can is the component that *receives
instructions from other agents*, so combining the two would build a path from
"peer message arrives" to "spawn an agent with permissions the receiver lacks".
Keeping them apart is what makes it safe to install at user scope everywhere.

**Same-account Claude-to-Claude messaging is Tin Can's too, as of 1.4.0.**
`SendMessage` also reaches those sessions, so there are two paths to one
destination — but only Tin Can's is recorded in `message_log`, and a peer list
that omitted the account read as the whole machine. See
[Which peers you see](./peers.md#which-peers-you-see).

**Nothing blocks.** `send_peer` returns when the peer's harness accepts the
message, never when the peer answers. There is no `await_reply`. The peer may
be mid-turn, may have exited, may have a human who has walked away — or may
have no human at all: [Muster](https://github.com/BrutalSystems/muster)
launches unattended agent-only sessions, and those are ordinary Tin Can peers.
`expect_reply` records intent and changes nothing.

**No interrupting a running turn, on any runtime.** `urgent` is accepted and
has no effect anywhere. Claude Code has no external interrupt, and Codex's
`turn/steer` requires an `expectedTurnId` that only the connection owning that
turn ever learns. Every message queues.

opencode used to be the exception, through the v2 prompt route's
`delivery: "steer" | "queue"`. **That is gone as of 0.6.0, deliberately.** The
route that accepted `steer` is the one that admits a message and then does not
run it on a TUI-hosted session (below); the v1 route that does run it has no
delivery mode. A reliable send with no steer beats a steer into a session that
never answers, so the capability was traded rather than kept. `peers` reports
per peer whether `urgent` does anything — believe that output over this
paragraph if the two ever disagree.

**Same machine only.** No network listener, no TCP port, no remote transport.
Both sockets are already restricted to the operating-system user, and Tin Can
does not widen that.

## Limits

Enforced in code, per peer:

| | Claude peers | Codex peers | opencode peers |
|---|---|---|---|
| Messages/minute | 10 | 3 | 3 |
| Identical repeat | dropped within 60s | dropped within 60s | dropped within 60s |
| Runaway ceiling | 50 per 10 min | 20 per 10 min | 20 per 10 min |
| Message size | 100,000 characters | 100,000 characters | 100,000 characters |

Codex is tighter because a queued submission starts a turn immediately on an
idle thread — every send is an interrupt in practice. opencode shares that
same tighter budget rather than a looser one of its own: the plugin
deliberately implements no rate limiting at all (see [opencode: inverted
reach](./how-it-works.md#opencode-inverted-reach)), and opencode's queue is durable, so a
flood there survives a restart rather than dying with the process. A refused
send tells the sender which message was dropped and not to resend.

### Known limits

Three things worth knowing before you rely on them, none of them bugs:

- **Replay detection is per-process.** After an opencode restart, a re-sent
  `message_id` is logged by the plugin as a fresh delivery even though
  opencode still de-duplicates it server-side — nothing is delivered twice,
  but the log line is approximate.
- **The plugin log keeps one generation.** It rotates to
  `opencode-plugin.log.1` once it passes 4 MB, and the next rotation
  overwrites that file. There is no history before it; pipe the log elsewhere
  if you need more.
- **A resumed session is not advertised until it is active.** A session opened
  with `opencode --continue` does not appear in any `peers` list until it next
  receives an event — a typed message, or agent activity. This was chosen
  over guessing from a session list, which would advertise sessions that are
  actually closed. See [When a Codex peer is unreachable](./troubleshooting.md#when-a-codex-peer-is-unreachable)
  for the analogous opencode note.
