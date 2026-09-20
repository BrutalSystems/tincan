# Tin Can — Change Notice: opencode Support

> For the agent maintaining Tin Can (`~/Source/brutalsystems/tincan`).
>
> Owner: Mike Williams · **Rev 2, 2026-09-20**
>
> **Scope: adding opencode as a third runtime.** Nothing else. The separate
> **Tin Can — Change Notice** covers Muster interop, the `CANONICAL_ID.md`
> write-down and Codex↔Codex peers; read it too, but its items are independent
> of these except where §7 below says otherwise.
>
> **Depends on a deliverable that does not exist yet:** the opencode plugin,
> specified in [`plugins/opencode/SPEC.md`](../plugins/opencode/SPEC.md) (Rev 2).
> That document is **authoritative for the wire format and the registry
> layout**. Where it and this notice disagree, it wins. Do not re-derive either
> from here.
>
> Verified against **opencode 1.18.31**.

---

## What changed in Rev 2

Rev 1 was written before the plugin's verification pass. That pass ran on
2026-09-20 against a live TUI and contradicted several things Rev 1 asserted.
The **design is unchanged** — inverted reach, plugin-side registry, Unix socket,
Tin Can never speaking HTTP. Only the premises moved.

| Rev 1 said | Reality | Effect here |
|---|---|---|
| Fake URL is `http://opencode.internal` | `http://localhost:4096/`, still nominal — nothing listens, external `curl` refused | None. Cosmetic, but Rev 1's string appears nowhere in the product |
| `/api/session/active` is a live-session enumerator | Returns `{"data":{}}` unconditionally, including mid-turn | None here; it removes one of the reasons Rev 1 gave for calling opencode's API the best of the three |
| `409 PromptConflictError` on re-submit of a known id | Identical re-submit returns **200** with the same `admittedSeq`; 409 is for a *mismatched* re-submit | §3's instruction is unchanged; only the expected status is |
| Suffix rule does not transfer to base62 | It transfers unmodified | **§7 is rewritten.** See below |
| Plugin ships as a single file | Entry file plus an unglobbed `tincan-lib/` directory | §5's install instructions change |
| `state` is `idle \| busy \| unreachable` | Plugin writes `idle \| busy` only | §2: `unreachable` is Tin Can's to infer and cache |

One capability was also discovered that Rev 1 assumed impossible — see §4.

---

## Why this exists

opencode is being added as a third runtime alongside Claude Code and Codex.

Its injection API is good: `POST /api/session/{id}/prompt` with an explicit
`delivery: "steer" | "queue"`, durable in SQLite, idempotent by message id, and
specified in an OpenAPI 3.1 document the server hands out at `GET /doc`. There
is also `POST /api/session/{id}/interrupt` and an event bus carrying
`session.idle` and `session.status`.

**None of it is reachable from outside.** A default `opencode` TUI opens no TCP
port. The server runs in a worker thread behind a nominal base URL with an
in-process fetch bridge, and there is no port file, lockfile, PID file or
environment variable anywhere on disk. Verified directly: with a TUI running,
an external `curl` to the advertised URL is refused and the process holds no
LISTEN socket.

> The published docs at <https://opencode.ai/docs/server/> still claim the TUI
> "randomly assigns a port and hostname". **That is stale and wrong for
> 1.18.31.** Anyone designing from the docs will build the wrong thing.

So the reach is inverted. A plugin running *inside* opencode advertises its
sessions and binds a Unix socket; Tin Can writes to that socket. Tin Can never
speaks HTTP to opencode.

---

## 1. Prerequisite: the plugin

Do not start this work before the plugin exists and passes its own acceptance
pass. Its five verification items are answered in SPEC Appendix A; the two
design-level ones — binding a Unix socket, and injecting from inside a portless
TUI — both passed, the second by a different route than Rev 1 assumed.

**There is no port-based fallback in v1.** Do not add one, even as a
convenience for users running `opencode serve`. One code path: if the plugin is
not installed, there are no opencode peers. That is a correct and legible
answer, not a failure state, and the `peers` diagnostic should say so plainly —
name the plugin, do not report an empty list.

---

## 2. Discovery

Read `~/.tincan/peers/opencode/ses_*.json`, honouring `TINCAN_HOME`. The plugin
writes one file per live session, atomically, and rewrites it when state
changes. Fields: `session_id`, `slug`, `title`, `directory`, `state`, `socket`,
`instance_id`, `pid`, `plugin_version`, `opencode_version`, `updated_at`.

**Match `ses_*.json` specifically.** The same directory also holds
`inst-*.sock` and `inst-*.caller.json` (§4). A glob of `*.json` will pick up
caller files and mistake them for sessions.

Four rules:

**Peer name comes from `slug`, not `title`.** opencode generates a stable
human-friendly slug (`nimble-wizard`) alongside a title that drifts as the
conversation develops — observed rewriting itself from `"New session - …"` to
`"PONG"` within two seconds of the first reply. A peer name that changes
underneath a caller is worse than an opaque one. Carry `title` through to
`peers` output as a description if useful, but never address on it.

**The socket is the liveness test.** A registry file whose socket refuses a
connection means that opencode instance is gone. Prune the file, report the
peer `unreachable` once rather than repeatedly. This is the same rule already
applied to Claude Code peers; reuse it rather than writing a second one. `pid`
is there as a secondary check if you want it.

**`unreachable` is yours, not the plugin's.** The registry `state` field is
only ever `idle` or `busy`. A plugin cannot observe its own absence — by the
time `unreachable` would apply, the plugin is gone. Infer it from the refused
socket and cache it in Tin Can's own view.

**State is pushed, not probed.** The plugin maintains `state` from opencode's
event bus, so unlike the other two runtimes Tin Can does not need to ask. Read
the field. Do not add a probe — you would be racing the plugin's writer for no
gain.

### Pruning has two owners

The plugin also sweeps orphans, at its own startup. This is not redundant, and
it changes two things for you:

- **Tolerate `ENOENT` mid-read.** The plugin can unlink a file between your
  `readdir` and your `readFile`. Skip and continue; it is not an error.
- **You cannot clean up the silent-crash case, and do not need to.** A session
  resumed with `opencode --continue` that is never typed into is never
  advertised (SPEC §5), so a `kill -9` there leaves an `inst-*.sock` with no
  `ses_*.json` beside it. Nothing in your model will ever see that file. The
  plugin's sweep handles it.

---

## 3. Delivery

Connect to the `socket` path named in the peer's registry file, write one JSON
object on one line, close. No auth line — the socket is owner-only at `0600`.
No response is written.

Shape (SPEC §7 is authoritative):

```json
{"to_session":"ses_f41a2b3c4ffeExampleSess01Z","message_from":"billing-api","text":"<enveloped text>","delivery":"queue","message_id":"msg_01J8…"}
```

Note the socket is **per opencode instance, not per session** — one instance
serves many sessions — which is why `to_session` is on the wire. Several
registry files will name the same socket path; that is expected.

### Four requirements specific to this path

**Always set `delivery` explicitly.** opencode's default is `"steer"`. Tin Can's
policy is queue-by-default. Omitting the field inherits opencode's default and
**silently inverts the policy** — no error, just every message interrupting a
working agent. Map Tin Can's existing `urgent` flag to `"steer"`; everything
else sends `"queue"`.

For what the two actually do: `steer` promotes into the *running* turn at the
next step boundary, merging with the agent's in-flight reasoning. `queue` waits
for the current continuation loop to drain and starts a fresh turn.

**`text` carries the envelope, unmodified.** opencode applies no provenance
framing of its own — an injected prompt is indistinguishable from the operator
typing it at that terminal. Confirmed end to end: the injected message appears
in the session transcript as an ordinary `user` message whose text is
byte-identical to what was sent. As on the Codex path, Tin Can's
`<peer_message>` envelope is the only thing marking a peer's words as a peer's,
which makes it the load-bearing safety control here rather than a
belt-and-braces addition. Do not shorten it, do not make it conditional on
runtime.

**`message_id` must match `^msg_`.** This is server-enforced, not a convention:
opencode returns a 400 `InvalidRequestError` — *"Expected a string starting
with \"msg_\""* — otherwise. Tin Can's ids already carry the prefix; if that
ever changes, this path breaks.

**Idempotency returns 200, not 409.** Re-submitting an identical `message_id`
returns **200** with the same `admittedSeq` and `timeCreated` — the existing
row. A 409 `ConflictError` is reserved for a *mismatched* re-submit under a
known id, which Tin Can should never produce. Do not build retry logic on top
that would change the text under a reused id.

---

## 4. Peer-list rule and self-exclusion

The rule set in the other notice's §5 — **expose what the host runtime cannot
already do** — extends to opencode without changing:

| Tin Can hosted in | Lists |
|---|---|
| Claude Code | Codex, opencode |
| Codex | Codex, Claude Code, opencode |
| opencode | Codex, Claude Code, opencode |

Claude Code stays the only runtime whose own kind is excluded, because
`SendMessage` covers it natively and two logged paths to one destination is
worse than one. opencode has no native peer messaging of any sort, so a Tin Can
instance hosted there lists everything — **including other opencode sessions**,
with self excluded exactly as on the Codex path.

### Resolving self — solved, and not the way Rev 1 proposed

Rev 1 suggested matching the registry file whose `pid` is an ancestor of the
Tin Can process, then narrowing by `directory`. **`pid` ancestry works and
`directory` does not narrow anything** — one instance commonly runs several
sessions in the same directory, and the plugin writes the same `directory` on
all of them. That approach can only identify the instance, which would force
you to over-exclude every sibling session.

opencode exports no `OPENCODE_SESSION_ID`, so the environment cannot name the
*session*. It does, however, name the *instance*: an MCP subprocess launched by
opencode 1.18.31 inherits **`OPENCODE=1`** and **`OPENCODE_PID=<pid of the
opencode process>`** — verified with a stub MCP server, whose reported
`OPENCODE_PID` matched the `opencode` entry in its own process ancestry. That is
better than Rev 1's ancestry walk: match `OPENCODE_PID` against the `pid` field
directly, with no process-tree traversal at all.

> **Order the runtime detection most-specific-first.** An MCP subprocess
> inherits the environment of whatever launched opencode. In the verification
> run — opencode started from a shell inside a Claude Code session — the
> subprocess saw `OPENCODE=1` *and* `CLAUDE_CODE_MESSAGING_SOCKET`,
> `CLAUDECODE=1` and `CLAUDE_CODE_SESSION_ID` together. `detectRuntime`
> currently returns `claude-code` the moment it sees that socket, so an
> opencode-hosted Tin Can would misidentify its own host. Check `OPENCODE`
> before the Claude Code variables, not after.

But the plugin's `tool.execute.before` hook does
receive the calling `sessionID`, **including for MCP-provided tools** — verified
with a stub MCP server, which produced
`{ tool: "probe_probe_ping", sessionID: "ses_…", callID: "call_…" }`.

So the plugin records it for you, at:

```
~/.tincan/peers/opencode/inst-<instance-id>.caller.json
```

```json
{
  "instance_id": "inst-a91f",
  "session_id": "ses_f41a2b3c4ffeExampleSess01Z",
  "pid": 41233,
  "tool": "tincan_send_peer",
  "at": "2026-09-19T14:02:11Z"
}
```

Resolve self as: read `OPENCODE_PID` from the environment, find the caller file
whose `pid` equals it, and take its `session_id`. The `pid` is on the file
itself, so this works even before any session has been advertised, and it needs
no process-tree walk.

**Known limitation — a concurrent sibling can make us resolve the wrong self.**
The caller file is scoped to the *instance*, not to a call: whichever session's
`tool.execute.before` fires most recently overwrites it. So if session A is
mid-request when sibling B in the same instance invokes a Tin Can tool, A reads
B's id, excludes B, and leaves **A itself** in A's own peer list — where a
self-send resolves as an ordinary peer and delivers. The `isSelfAddress`
backstop does not catch it, because `resolvePeer` reports a genuine match
rather than `unknown`.

Closing it needs a change on the plugin side, not the Tin Can side: the hook
already receives a `callID`, so the caller file could carry it (or the plugin
could write one file per call and let the reader pick by recency plus id).
Either is a spec change beyond the current interface, which is why it is
recorded here rather than patched. The exposure is narrow — two sessions in one
opencode instance both driving Tin Can within the same read window — and the
failure is a message delivered to yourself, not to a wrong third party.

Two caveats worth knowing:

- The file is written when a tool whose id ends in `_peers`, `_send_peer` or
  `_message_log` executes — **suffix, not prefix**, because opencode names an
  MCP tool `<server key>_<tool name>` and the server key is whatever the user
  put in their config. A user who registers Tin Can as `tc` gets
  `tc_send_peer`.
- It is absent until the first Tin Can tool call in that instance. On the very
  first `peers` call the hook fires before the MCP server is invoked, so it is
  present by the time you read it — but code defensively, and fall back to
  instance-level exclusion if it is missing.

---

## 5. Hosting Tin Can inside opencode

opencode is an MCP client. Register Tin Can in `~/.config/opencode/opencode.json`
(or project-level `opencode.json`):

```jsonc
{
  "mcp": {
    "tincan": {
      "type": "local",
      "command": ["node", "/abs/path/dist/tincan.js"],
      "enabled": true
    }
  }
}
```

**Two installs, two locations, and the README must make confusing them
impossible.** The MCP server is how an opencode session *sends*. The plugin is
how it *receives*. Both are required for two-way messaging. Someone who installs
only one gets a peer that can talk but not listen, or listen but not talk,
**with no error message telling them so** — the failure is silent on both sides.

The plugin half is no longer a single file. It is:

```bash
mkdir -p ~/.config/opencode/plugin
cp plugins/opencode/tincan.ts ~/.config/opencode/plugin/
cp -r plugins/opencode/tincan-lib ~/.config/opencode/plugin/
```

`tincan.ts` must sit **directly** in `plugin/` — the loader globs one level
only, so a nested `plugin/tincan/tincan.ts` never loads, while
`plugin/tincan-lib/` is correctly ignored.

Write the install section as a single numbered sequence covering both halves,
and add a troubleshooting line for each half-installed state and what it looks
like.

---

## 6. Guard, envelope and log — unchanged and fully applied

Rate limit, identical-repeat drop and queue cap apply to opencode traffic
exactly as to the other runtimes. **The plugin deliberately implements none of
this**, so Tin Can is the only thing standing between a runaway exchange and a
flooded session. Do not weaken any of it on the grounds that opencode queues
durably — durable queueing means a flood survives a restart.

`message_log` records opencode traffic in the same shape as the rest, including
the `delivery` mode used.

---

## 7. Naming — the existing rule already covers all three

**This section is reversed from Rev 1.** Rev 1 argued that base62 ids break the
suffix rule and that a new three-shape rule was needed. That was wrong, and
acting on it would have produced exactly the divergence Rev 1 was trying to
prevent.

Rev 1's argument assumed the suffix is taken raw from the id's tail, making
`.0fb` and `.BDv` different kinds of token. It is not.
[`CANONICAL_ID.md`](../CANONICAL_ID.md) strips every character outside
`[0-9a-f]` case-insensitively, takes the **last three**, and lowercases. Every
runtime therefore yields the same token: a lowercase hex triple.

| Runtime | Id | Suffix |
|---|---|---|
| Codex | `01a0b9b4-a33e-7ab1-80a0-bb715504a0fb` | `0fb` |
| Claude Code | UUID session id | last three hex |
| opencode | `ses_f41a2b3c4ffeExampleSess01Z` | `e01` |

It also works for the right reason. An opencode id is `ses_` + about twelve hex
characters of descending timestamp + about fourteen base62 random. Taking the
**last** three draws from the random tail rather than the shared timestamp
prefix — precisely the property the rule was written for against Codex's
UUIDv7. Eight real session ids produced eight distinct suffixes.

**So: do not invent a new rule. Add opencode cases to
`test/fixtures/canonical-id.json` and record two caveats in `CANONICAL_ID.md`:**

- Filtering base62 down to hex skews the alphabet — `a`–`f` are reachable from
  both letter cases while digits come from one — so collision odds sit somewhat
  above a uniform 1 in 4096. Worth stating, not worth changing.
- The fixed hex prefix guarantees at least three hex characters, so an opencode
  id can never produce the empty suffix that `CANONICAL_ID.md` records as a
  known defect.

Muster is being built against that document. Report what you add.

---

## 8. Explicitly unchanged, and out of scope

Unchanged: `envelope.ts`, `guard.ts`, `log.ts` and the `peers` / `send_peer` /
`message_log` schemas. A new runtime adds peers to a list; it does not change
what a peer is.

Out of scope, deliberately:

- **An HTTP path to opencode**, including for users running `opencode serve`
  with a pinned port. One code path.
- **`/tui/append-prompt` and `/tui/submit-prompt`.** These put text in the
  *human's* composer rather than the agent's context — a channel neither other
  runtime has. Interrupting a person is a different product decision from
  messaging an agent, and it belongs in a later conversation about operator
  notification.
- **Reading opencode's SQLite database** at
  `~/.local/share/opencode/opencode.db` directly. Tin Can reads the plugin's
  registry files and nothing else of opencode's.
- **ACP.** opencode speaks the Agent Client Protocol over stdio via
  `opencode acp`, and so do most coding agents now — but ACP is editor↔agent
  with the client spawning the agent, which is the wrong shape for attaching to
  sessions that already exist. It is relevant to Muster, not to Tin Can.

---

## 9. Done means

With the plugin installed and a plain `opencode` TUI running with no flags:

- That session appears in `peers` from a Claude Code host and from a Codex host,
  named from its slug, with state tracking the agent's activity.
- A `send_peer` to it lands in the agent's context and the agent acts on it.
- `delivery` is `queue` by default and `steer` only when `urgent` is set —
  asserted in a test, not just observed.
- The envelope arrives byte-identical.
- From inside opencode, `peers` lists Codex, Claude Code and other opencode
  sessions, excluding itself, and a self-send is refused — with self resolved
  from the caller file, so a sibling session in the same instance is still
  addressable.
- Quitting the TUI removes the peer; killing it with `-9` leaves a registry file
  that Tin Can prunes on first contact.
- A session resumed with `opencode --continue` and not yet typed into does not
  appear, and appears correctly once it is active. This is expected behaviour,
  not a bug — see SPEC §5.
- `CANONICAL_ID.md` and the fixture cover all three id shapes.
