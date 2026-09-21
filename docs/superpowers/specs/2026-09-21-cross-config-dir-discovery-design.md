# Cross-config-dir Claude Code discovery

> Design, 2026-09-21. Not shipped behaviour — `CANONICAL_ID.md` remains the
> write-down of what Tin Can does today, and this document does not change it.

## The problem

Claude Code can be started with `CLAUDE_CONFIG_DIR` pointing somewhere other
than `~/.claude`. That is how you run a second account on one machine, and it
is what makes the second session invisible to the first: `SendMessage` and
`ListAgents` are scoped to the session's own config dir.

Verified on this machine, 2026-09-21:

- pid `62821` is a live Claude Code session with
  `CLAUDE_CONFIG_DIR=/Users/mikewilliams/.claude-arm`, cwd
  `~/Source/arm/cxx-be`, registry name `cxx-be-6e`.
- `ListAgents` from a session under `~/.claude` returns exactly 9 peers —
  precisely the 9 records in `~/.claude/sessions`. `cxx-be-6e` is absent.
- Its socket is `/tmp/cc-socks/62821.sock`: the **shared** socket directory,
  alongside every other session's.

So the transport is already common ground. What is partitioned by config dir is
the registry — the `pid -> socket` record carrying name, cwd and status, and the
`<pid>.<hash>.key` file holding the inbound `peerToken`.

`src/claude/discover.ts` reads both out of one `registryDir`, and
`claudeRegistryDir()` (`src/runtime.ts:27`) is hardcoded to
`homedir()/.claude/sessions`, ignoring `CLAUDE_CONFIG_DIR` entirely.

### The blind spot is wider than Claude-to-Claude

The Codex and opencode arms both list `claude-code` peers
(`src/runtime.ts:201`, `src/runtime.ts:313`) through that same hardcoded path.
They are equally blind to `cxx-be-6e`. And a Tin Can hosted *inside* an
alternate-config session looks for its own record in `~/.claude/sessions`, does
not find it, and falls back to `basename(cwd)` for its own name
(`selfNameFor`, `src/runtime.ts:50`). It already misnames itself today.

One hardcoded path is the root cause of all four symptoms. This design fixes the
path.

## What was measured, not assumed

Four facts shaped the design. Each was checked rather than reasoned about.

1. **The MCP child inherits the session environment.** `ps -E` on Tin Can's own
   child process shows `CLAUDE_CODE_MESSAGING_SOCKET` and
   `CLAUDE_CODE_SESSION_ID` passed straight through. `CLAUDE_CONFIG_DIR` arrives
   by the same route.
2. **`CLAUDE_CODE_MESSAGING_TOKEN` is not the token peers need.** Its value
   differs from the `peerToken` in the session's own `.key` file (compared by
   hash). Inbound auth lives only in that `0600` file inside the `0700` config
   dir, so a self-registering Tin Can cannot publish its own reachability from
   the environment alone — it would have to copy a secret.
3. **A session may run no Tin Can at all.** pid `62821` has no Tin Can child
   process. Anything keyed on self-registration cannot see it, which is why
   self-registration cannot be the only source.
4. **Status is live in the harness registry and nowhere else.** Records carry
   `status` and `statusUpdatedAt`. An MCP server is not told when its session
   goes idle or busy, so a self-written record could only ever offer
   live/unreachable from a socket probe.

## Decisions

### Fix the root cause, not the symptom

`claudeRegistryDir()` becomes `claudeRegistryDirs()`. Every arm that lists
Claude peers gets the fix, and the self-naming bug goes with it. The alternative
— a new peer class on the Claude arm only — leaves the same hardcoded path in
two other call sites.

### Tin Can self-registers, and the record is a pointer

Each Tin Can hosted in Claude Code writes a record naming its config dir, so the
common case is "our own dir, plus every dir some record names" — exact, portable,
and with no heuristic to defend. It does not cover a session running no Tin Can,
which is what the third source below exists for.

The record carries **no name, cwd, status or token**. Those are read live from
the harness registry it points at. Consequences:

- One source of truth. Nothing to keep in sync.
- No secret is duplicated out of the `0700` dir.
- `idle` / `busy` survives, where a copied record would have degraded it.
- **A stale pointer is nearly harmless.** It names a *directory*, whose sessions
  are probed as they always were. A stale copy would have conjured a phantom
  peer — the shape of issue #12.

### Three sources, degrading honestly

Rejected outright: globbing `~/.claude*`. Nothing constrains `CLAUDE_CONFIG_DIR`
to `$HOME`, to a dotfile, or to the string `claude` — `/opt/work/cc` is legal. A
glob is a guess about a convention that does not exist.

Config dirs are found from three sources, in order:

1. **Our own dir** — `CLAUDE_CONFIG_DIR` or `~/.claude`. Always.
2. **Pointer records** — cheap, exact, no platform dependency.
3. **A socket sweep** — the fallback, for sessions that run no Tin Can.

Layer 3 splits into two halves with very different risk.

**Detection needs no heuristic at all.** Every live session binds `<pid>.sock` in
the shared socket dir, and `socketDirCandidates()` (`src/claude/discover.ts:27`)
already encodes where that is. Sweep it, take the pids, subtract every pid layers
1 and 2 account for. The remainder is the set of live sessions in config dirs we
do not know. On the machine this was written against, that remainder is exactly
`{62821}`.

This adds no assumption Tin Can does not already ship. It depends on knowing
where sockets live — which the code already asserts — and on nothing whatsoever
about where config dirs live.

**Resolution is the only platform-specific part**: read that process's own
environment for `CLAUDE_CONFIG_DIR` — `ps -E -p <pid>` on darwin,
`/proc/<pid>/environ` on linux, both same-uid. It runs only for pids in the
remainder, which is normally empty, so the common case costs nothing.

**The answer is a tri-state, and flattening it is a bug that shipped in 0.7.0.**
A session in the *default* config dir names it by the **absence** of
`CLAUDE_CONFIG_DIR`, not by a value — on the machine this was written against,
exactly one live session of eleven set the variable at all. So "read the
environment, found no override" means `~/.claude`; only "could not read the
environment" means unidentified. 0.7.0 returned `undefined` for both, which
looked harmless from a default-dir session — where layer 1 accounts for those
pids and the sweep never reaches them — and turned every default-dir session
into `unknown-<pid>` when seen from a session under a different config dir.
That is the only vantage point this sweep exists to serve, so the harmless-
looking case was the one that never mattered.

Extract `CLAUDE_CONFIG_DIR` and discard the rest. A process environment is full
of secrets that are none of Tin Can's business: never log it, never retain it,
never put it in a diagnostic.

**When resolution fails, the peer is still listed** — `state: unreachable`, with
a diagnostic naming the pid and saying a live session was seen outside every
known config dir. Tin Can already has that state. The failure mode is then "there
is a session here I can see but cannot address", not silence. Issue #17 names
the opposite — *not a crash, just a quiet wrong answer* — as the month's bug
pattern; this is the antidote to it.

### A peer's pointer says whether it can reply

Layer 3 costs an invariant that layers 1 and 2 had on their own: a peer found by
sweep provably has **no** live Tin Can, because it wrote no pointer. It can
receive a message and cannot answer it — the envelope's "reply with `send_peer`"
is advice it cannot follow.

That is worth keeping rather than hiding, because the same fact is also the fix:
**pointer present means the peer can reply; pointer absent means it cannot.** Tin
Can knows this per peer, for free, and should say so — `can_reply` on the peer,
and an envelope that tells an unequipped receiver to answer in its own terminal
instead of naming a tool it does not have.

**This is a pre-existing defect that the pointer set merely makes visible.** The
Codex and opencode arms already list every Claude session in the default config
dir, whether or not it runs Tin Can, and already send all of them an envelope
instructing a `send_peer` reply. Until now nothing could tell the difference.
Fixing it there is adjacent work, not this spec's, but it should be filed.

## Design

### The record

`${TINCAN_HOME:-~/.tincan}/peers/claude-code/<sessionId>.json`, one per session,
mirroring the existing opencode layout.

```json
{ "sessionId": "06a0f0b0-f629-4f1c-a8a5-b861432451a1",
  "pid": 62821,
  "configDir":   "/Users/mikewilliams/.claude-arm",
  "registryDir": "/Users/mikewilliams/.claude-arm/sessions",
  "procStart": "Mon Sep 21 17:28:55 2026",
  "tincanVersion": "0.6.6",
  "writtenAt": 1790011740004 }
```

Discovery needs only `registryDir`. `pid` and `procStart` exist so a stale record
can be pruned precisely rather than guessed at. Several sessions under one config
dir produce several records naming the same dir; readers dedupe.

One file per session, not one per config dir with a refcount: per-session files
prune cleanly and never need a concurrent read-modify-write.

**Lifecycle.**

- Written at MCP boot when `detectRuntime()` returns `claude-code`.
- Removed on exit — normal exit, `SIGTERM`, `SIGINT`.
- Atomic write: temp file plus rename. Mode `0600` in a `0700` directory.
- Self-identification: `configDir` from `CLAUDE_CONFIG_DIR` when set and
  non-empty, else `~/.claude`. Session pid from the basename of
  `CLAUDE_CODE_MESSAGING_SOCKET` (`/tmp/cc-socks/97213.sock` -> 97213),
  cross-checked against ppid, which is the session process. Where the two
  disagree, the validation below decides it: try each, keep whichever has a
  record matching our session id.
- **Refuse to register when unsure.** If the pointed-at dir holds no
  `<pid>.json` whose `sessionId` matches `CLAUDE_CODE_SESSION_ID`, write nothing.
  A missing peer is recoverable; a record pointing at the wrong dir is not.
- A crash leaves a record behind. It is pruned on read when the pid is dead, or
  `procStart` disagrees with the live process, or `registryDir` no longer exists.

Issue #12 (`tightened` can go stale if `chmod` throws) is a hazard of the same
shape on the opencode side. Whatever that path settles on, this one matches it.

### Discovery

```
claudeRegistryDirs(env, home): string[]
  1. (env.CLAUDE_CONFIG_DIR || ~/.claude) + "/sessions"   -- always, always first
  2. every distinct registryDir named by a live pointer record
  3. realpath-dedupe; drop what does not exist
```

`listClaudeSessions` takes `registryDirs: string[]` and applies today's logic per
dir. It returns the sessions it found **and the pids it accounted for**, which is
what the sweep subtracts.

```
sweepUnaccounted(env, uid, accountedPids): Unaccounted[]
  for each dir in socketDirCandidates(env, uid):
    for each <pid>.sock:
      pid not in accountedPids and pid is live
        -> resolveConfigDir(pid)                 -- ps -E | /proc/<pid>/environ
             resolved   -> add dir, re-run listClaudeSessions for it
             unresolved -> emit an unreachable peer + a diagnostic
```

Resolution feeds back into layer 1/2's own machinery rather than parallelling it:
a resolved dir is appended to `claudeRegistryDirs` and read exactly like any
other, so name, cwd, status and token all come from one code path. Only the
unresolved case has a peer shape of its own, and it carries no name — `pid
62821` is all it honestly knows.

The sweep runs once per `peers` call, after the registries are read. It cannot
run before: "unaccounted" is defined by what the registries returned.

**New hazard: the same pid in two registries**, one of them stale. Resolution
order — `procStart` against `ps -p <pid> -o lstart=`; failing that, the socket
probe; failing that, **drop both and emit a diagnostic**. Guessing means sending
with a token belonging to a dead session.

**But first establish that it is a collision at all**, which 0.7.1 did not and
which cost every default-dir session. Two conditions make one directory appear
twice: dedupe by `resolve()` is textual, so one directory reached by two paths —
a symlinked home, `/tmp` against `/private/tmp` — counts as two; and the sweep
can resolve a stranger into a directory the caller already knew, which after
"no override means the default dir" is the *common* case rather than a rare one.
Either way every session in that directory looks like it appears in two config
dirs, matches the live `procStart` twice, and is dropped as ambiguous.

So: dedupe canonically (`realpath`, not `resolve`) at every point a directory
list is built, and treat two records that name the **same `sessionId`** as one
session seen twice rather than a conflict. A genuine collision is a recycled
pid, and those records name different sessions. An empty `sessionId` proves
nothing and never collapses.

**Self-exclusion becomes load-bearing on the Claude arm.** Today that arm lists
no Claude peers at all, so `pid === selfPid` in `listClaudeSessions` — which
compares against Tin Can's own pid and can never match a session — costs
nothing. Once the arm lists Claude peers, exclusion must be explicit and keyed
on `CLAUDE_CODE_SESSION_ID`, as the opencode arm already does
(`src/runtime.ts:223`).

### The peers contract

The Claude arm's `peerRuntimes` becomes `['codex','opencode','claude-code']`,
with `claude-code` filtered to peers whose `registryDir` differs from ours.

> On the Claude Code arm, Tin Can lists a `claude-code` peer only when it is one
> `SendMessage` cannot reach.

This keeps the README's stated reason — *two logged paths to one destination is
worse than one* — and drops only its overly broad implementation. The exclusion
was never about the runtime; it is about reachability, and `SendMessage` reaches
exactly one config dir. The "do not fix it into symmetry" note is rewritten to
say that, not deleted.

The scoping is stated at runtime as well as in the README: the `peers`
description and every result note must now say that *same-account* sessions are
excluded and name `SendMessage` as their path. A list that still claims to
exclude all Claude sessions lies, just differently.

Peers gain two fields:

- `config_dir`, so `cxx-be-6e` is visibly not `cxx-be-16`.
- `can_reply`, true exactly when the peer wrote a pointer. A peer found only by
  the sweep gets `false`, and its envelope tells it to answer in its own terminal
  rather than naming a `send_peer` it does not have.

A swept peer that could not be resolved is listed with no name, `state:
unreachable`, and the diagnostic. It is addressable by nothing and exists in the
list purely so the user learns it is there.

**Canonical ids do not change.** The suffix already derives from the session id,
so two same-named sessions in different config dirs already differ.
`CANONICAL_ID.md` and `test/fixtures/canonical-id.json` are untouched, and that
is a thing to assert rather than assume.

### Delivery

No change for a resolved peer. `sendToInbox` takes a socket path and an
`InboxAuth`; the socket is in the shared socket dir and the token reads out of
the resolved dir's key file under the same uid. Between two Tin Can-equipped
sessions the reply path is symmetric — both register, both read the union.

**Settled by probe, 2026-09-21. The inbox accepts an unauthenticated write.**
Two frames were sent to one live session's socket — the first with no auth
frame, the second with a valid one — and the receiving session reported both
arriving, payload intact, in order. The socket itself answered nothing in either
case, so the differential had to be read at the receiver.

The `peerToken` is therefore not required for delivery on Claude Code 2.1.267,
and **an unresolved swept peer is deliverable, not merely informational**: its
socket is known, and the token it has no way to supply turns out not to be
needed. Its `state` comes from the ordinary socket probe like anyone else's.

Two things this does not mean. It is not a security finding: the socket is
`0600` and the whole design is already scoped to one uid, so an unauthenticated
write is inside a trust boundary Tin Can never claimed to defend. And it is an
*observation of one version*, not a contract — if a later build enforces the
token, an unresolved peer starts failing delivery. That is the right failure
mode, being loud rather than wrong, but the code comment should say so.

### Two latent bugs in the code this touches

- `findSessionName` (`src/runtime.ts:75`) matches `rec.pid === pid` using Tin
  Can's own pid, which can never equal a session's. Dead code — and it is the
  fallback meant to cover a missing `CLAUDE_CODE_SESSION_ID`.
- As a direct consequence, a session under an alternate config dir misnames
  itself as `basename(cwd)` today.

Both are fixed here rather than filed, because this change rewrites their
surroundings.

## Not in this spec

**Aliases.** Tracked separately. The binding is decided — an alias names a *live
session* and is rebound by hand; it dies with the session rather than surviving a
restart. The shape is `~/.tincan/aliases.json`,
`{"reviewer": {"sessionId": "…", "setAt": …}}`, with an exact alias match beating
name-prefix match in peer resolution, and a stale alias erroring as *stale* —
naming the dead session — rather than as `peer_unknown`.

It is recorded here only to confirm the registry forecloses nothing: aliases need
no field added to the pointer record. Issue #17 files alias tables under future
multi-machine shared state (CRDTs, last-write-wins registers); on one machine
none of that applies, so aliases do not wait on identity work.

**Multi-machine.** Unchanged and out of scope. Every path here is same-uid,
same-machine.

## Testing

Unit, against fixture registries under a temp home:

- two config dirs -> the union, deduped; our own dir first.
- a pointer naming a dir that no longer exists -> dropped, no throw.
- the same pid in two dirs, `procStart` matching one -> the other is dropped.
- the same pid in two dirs, neither matching -> both dropped, diagnostic emitted.
- self-exclusion by `CLAUDE_CODE_SESSION_ID` on the Claude arm.
- same-dir Claude peers excluded on the Claude arm; cross-dir listed.
- Codex and opencode arms list cross-dir Claude peers with no filter.
- pointer written at boot, removed at exit; a record whose pid is dead is pruned
  on read.
- `test/fixtures/canonical-id.json` unchanged.

The sweep, with the socket dir and the resolver both injected:

- a socket whose pid no registry accounts for -> detected as unaccounted.
- every socket accounted for -> **the resolver is never called**. Assert the
  call count, not just the result: the whole cost argument rests on this.
- resolution succeeds -> the dir is appended and the peer comes back fully
  formed, with name and status, through the ordinary registry path.
- resolution fails -> one unreachable peer, no name, a diagnostic naming the pid,
  and no throw.
- `can_reply` is false for a swept peer and true for a pointer peer.
- a stale socket file whose pid is dead -> not reported as an unaccounted live
  session.
- the resolver returns an environment containing other variables -> only
  `CLAUDE_CONFIG_DIR` is retained, and nothing else reaches the log or the
  diagnostic.

End-to-end, by hand, in two passes:

1. With no Tin Can in `cxx-be-6e` — it should appear via the sweep, resolved to
   `~/.claude-arm`, `can_reply: false`, and take delivery.
2. With Tin Can running there — it should appear via its pointer,
   `can_reply: true`, and a reply should come back.
