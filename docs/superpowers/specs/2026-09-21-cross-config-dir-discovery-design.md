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
   process. Anything keyed on self-registration cannot see it.
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

Each Tin Can hosted in Claude Code writes a record naming its config dir.
Discovery is then "our own dir, plus every dir some record names" — no globbing
of `~/.claude*`, no per-platform environment reading, no heuristic to defend.

The record carries **no name, cwd, status or token**. Those are read live from
the harness registry it points at. Consequences:

- One source of truth. Nothing to keep in sync.
- No secret is duplicated out of the `0700` dir.
- `idle` / `busy` survives, where a copied record would have degraded it.
- **A stale pointer is nearly harmless.** It names a *directory*, whose sessions
  are probed as they always were. A stale copy would have conjured a phantom
  peer — the shape of issue #12.

### Pointers and our own dir are the only sources

Rejected: globbing `~/.claude*`, and an explicit `TINCAN_CLAUDE_CONFIG_DIRS`.

The cost is real and worth stating plainly: **a Claude session running no Tin Can
is invisible across a config-dir boundary.** pid `62821` stays unlisted until
some session under `~/.claude-arm` has run Tin Can once. This narrows the
README's "reaches sessions that never exposed anything and were not built to be
reachable" — which remains true *within* a config dir, and is why that claim in
the README needs qualifying rather than deleting.

What it buys is an invariant that holds without any further machinery:

> A discoverable cross-dir peer always has a live Tin Can — because being
> discoverable *means* it wrote a pointer, and the pointer dies with it.

So the envelope's instruction to reply with `send_peer` can never be advice a
cross-dir receiver is unable to follow. Under the glob, it could have been.

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
dir.

**New hazard: the same pid in two registries**, one of them stale. Resolution
order — `procStart` against `ps -p <pid> -o lstart=`; failing that, the socket
probe; failing that, **drop both and emit a diagnostic**. Guessing means sending
with a token belonging to a dead session.

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

Peers gain `config_dir`, so `cxx-be-6e` is visibly not `cxx-be-16`.

**Canonical ids do not change.** The suffix already derives from the session id,
so two same-named sessions in different config dirs already differ.
`CANONICAL_ID.md` and `test/fixtures/canonical-id.json` are untouched, and that
is a thing to assert rather than assume.

### Delivery

No change. `sendToInbox` takes a socket path and an `InboxAuth`; the socket is in
the shared `/tmp/cc-socks` and the token reads out of the foreign dir's key file
under the same uid. The reply path is symmetric by construction — both sides
register, both read the union.

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

End-to-end, by hand: a message from a `~/.claude` session to `cxx-be-6e` under
`~/.claude-arm`, and a reply. Requires that session to run Tin Can once first —
by design, per the decision above.
