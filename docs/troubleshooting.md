# Troubleshooting

Symptoms, what they mean, and what to do about them.

## Troubleshooting

**`peers` is empty, or missing a session you can see.**
Tin Can must be installed on every side you want to reach (see [Which peers you
see](./peers.md#which-peers-you-see) for exactly which runtimes each host lists), so an
empty or short list often just means the runtime it names has nothing running
— not that Tin Can is broken. Check the `diagnostic` field, which says what is
wrong. For opencode specifically, "nothing running" and "not installed" look
identical from here; the two rows below tell them apart.

**An opencode session can send but never shows up as anyone else's peer.**
The MCP registration is installed, the plugin is not. It can talk, not
listen. See [Install](./install.md#install).

**An opencode session shows up as a peer but has no Tin Can tools of its own.**
The plugin is installed, the MCP registration is not. It can listen, not
talk. See [Install](./install.md#install).

**A tool you just installed is not there.**
MCP servers and opencode plugins are both loaded at session startup. Restart
the session.

**A Codex peer says `unreachable`.**
Three causes, and `peers` names which one. The session has not taken its first
turn yet (send one prompt in that terminal); it is a `codex exec` run, which
accepts input and exits without reading it; or it is an ephemeral or subagent
thread, which rejects queued input by design.

**An opencode peer says `unreachable`.**
Its registry file's socket refused a connection — that opencode instance is
gone. Tin Can prunes the file and reports it once. See [When a Codex peer is
unreachable](#when-a-codex-peer-is-unreachable) for the full note.

**An opencode session started with `opencode --continue` never appears.**
Expected if it has not been typed into yet — it is not advertised until its
next activity. See [Known limits](./design.md#known-limits).

**A message was delivered but the peer never answered.**
Delivery is fire-and-forget by design — `outcome: "accepted"` means the peer's
harness took it, not that anyone read it. The peer may be busy, gone,
attended by a human who has walked away, or unattended by design.
`expect_reply` records that you are waiting; nothing blocks.

**A peer name stopped resolving.**
Names belong to processes and die with them. Re-run `peers` rather than caching
a name; `message_log` keeps the durable ids.

## When a Codex peer is unreachable

A Codex thread reaches `thread/list` only after its **first turn**, but it holds
its writer lock from launch. Tin Can lists such a session — liveness is the lock,
not the listing — but marks it `unreachable`, because `thread/queue/add` fails
with *"no rollout found for thread id …"* until a rollout exists. `peers` says
so. Send one prompt in that terminal and it becomes addressable.

Also unreachable, and correctly so: ephemeral threads and subagent threads, which
report `canAcceptDirectInput: false`.

An opencode peer is marked `unreachable` on the same principle, by a different
mechanism: its registry file's socket refused a connection, meaning that
opencode instance is gone (quit, crashed, or killed). Tin Can prunes the file
and reports the peer `unreachable` once rather than on every call. A session
resumed with `opencode --continue` is a separate case — it does not appear in
`peers` at all, reachable or not, until it next does something. That is
expected, not a bug: see [Known limits](./design.md#known-limits).
