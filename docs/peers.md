# Which peers you see, and how they are named

Who appears in a listing, why a peer might be missing, and the rules that
decide what you can type as an address.

## Which peers you see

**Every host lists every live session on the machine, itself excepted.**

| Hosted in | Lists |
|---|---|
| Claude Code | Codex, Claude Code, opencode |
| Codex | Codex, Claude Code, opencode |
| opencode | Codex, Claude Code, opencode |

The Claude Code row used to read *"Claude Code sessions in **other** config
dirs"*, because `SendMessage` already reaches the same-account ones and two
logged paths to one destination looked worse than one. Only one of those paths
is logged, though: a same-account `SendMessage` leaves no record in
`message_log`. So the scoping bought symmetry with the native path at the price
of a peer list that did not describe the machine and a log that could not
account for every send — and callers reported the short list to their users as
the whole machine anyway, which is the failure the scoping note existed to
prevent. Since 1.4.0 the list is simply the machine, and there is no note.

The one Claude Code session never listed is the calling session itself, keyed on
`CLAUDE_CODE_SESSION_ID`. When that variable is missing Tin Can cannot tell
itself from a sibling, so it falls back to hiding its whole config dir: a hidden
same-account peer is recoverable, a message delivered to your own inbox is not.

Tin Can finds another config dir two ways. Every Tin Can running in Claude Code
writes a small pointer record under `~/.tincan/peers/claude-code/` naming its
own config dir and nothing else — no name, no status, no token, all of which
stay in the harness registry and are read live. For a session that is *not*
running Tin Can, the socket directory gives it away: every live session binds
`<pid>.sock` there regardless of config dir, so a socket no registry accounts
for is a session Tin Can has not met, and reading that process's own
`CLAUDE_CONFIG_DIR` says where to look. When that read fails the session is
still listed — named by pid, with a note — because a session you can see but
cannot identify is a better answer than silence.

A peer found that second way has no Tin Can of its own, so it can receive a
message and cannot reply. `peers` reports that as `can_reply: false`, and the
envelope such a peer receives asks it to tell its user rather than naming a tool
it does not have.

Codex and opencode have no native
model-callable peer messaging at all — Codex ships collaboration tools, but
they are scoped to a spawn tree rather than to independently launched sessions
(below), and opencode has nothing of the kind — so both list everything,
including their own kind, with self excluded.

Codex does ship collaboration tools — `collaboration.list_agents`,
`collaboration.send_message`, `spawn_agent` and friends, enabled by the
`multi_agent` feature. They are **scoped to a spawn tree**: `list_agents`
describes itself as listing "live agents in the current root thread tree", and
`send_message` targets a "relative or canonical task name *from `spawn_agent`*".

Checked from both sides of that boundary, on two live sessions:

- A session that had spawned nothing saw only itself — `{"agents":[{"agent_name":"/root"}]}`.
- A session that had spawned a sub-agent saw itself *and* that child, `/root`
  and `/root/review`.
- Neither saw any of the other live Codex sessions on the machine.

So `list_agents` does find agents — just only the ones below it in its own tree.
The two are complementary rather than competing: Codex's tools reach agents you
created, Tin Can reaches sessions someone else launched.

Tin Can never lists the session it is running in, and refuses a send addressed
to it with a message saying so.

**Codex busy-detection is best-effort.** `thread/list` reports a thread's status
relative to the app-server that asked, and Tin Can spawns its own — so a live
thread almost always reports `notLoaded` even while its operator is mid-turn.
Tin Can reads that as `idle`, because the alternative told every sender they
were interrupting someone. A Codex peer marked `idle` means *reachable and not
known to be busy*, not *definitely free*. Claude Code peers report real state
from the session registry. opencode peers report real state too, pushed live
by the plugin from opencode's own event bus — Tin Can never has to probe an
opencode peer to know whether it is busy.

### opencode: why the plugin posts to the v1 route

opencode has two prompt APIs, and they are different engines. Tin Can's plugin
uses the v1 one — `POST /session/{id}/prompt_async`, answering 204 — and must
keep using it.

| | v2 `/api/session/{id}/prompt` | v1 `/session/{id}/prompt_async` |
|---|---|---|
| Engine | admit + wake + run coordinator | `SessionPrompt.Service` |
| Answers | 200 with an `admittedSeq` | 204, empty body |
| TUI-hosted session | admits, schedules a turn, **the turn dies resolving the model** | **runs** |
| `opencode serve` | runs | runs |
| Failure visibility | log file only | publishes `Session.Event.Error` into the session |
| Steer / queue | `delivery` field | none |

The v2 route was the obvious choice and it is the wrong one. On a TUI-hosted
session it admits the message durably — the text really does become a
`type:"user"` message — schedules a turn within about 70ms, and that turn then
fails to resolve the session's own model and dies before the agent runs. 20
observed failures across two unrelated providers, zero successes, while a turn
started from the TUI itself streams that same model fine seconds later. And
nothing surfaces it: the POST has already answered 200, no error is written
into the session, and the only trace is one `ERROR "Failed to drain Session"`
line in `~/.local/share/opencode/log`.

The v1 route simply runs the message. Verified on stock opencode 1.18.31 in a
plain TUI session: three sends, three turns, three answers in the pane.
`Intelligent-Internet/opencode-a2a`, the reference A2A integration, posts to
this route too — though it only ever runs `opencode serve`, so it would never
have discovered the difference.

**Do not "fix" the URL back to `/api/`.** It is not the v2 path with a prefix
dropped; it is a different route on a different `HttpApi`. The v2 surface
describes itself in its own OpenAPI annotation as an *"Experimental HttpApi
surface for selected instance routes"*, and `prompt_async` does not appear in
its `/doc` output at all.

Two consequences worth knowing:

- **`urgent` no longer does anything for opencode peers.** v1 has no
  `delivery` field. See the limits section above.
- **One observation we did not chase:** after a failed v2 admission, later v1
  sends to that same session returned 204 and ran nothing either. A Tin Can
  that only ever calls v1 never creates that state, but if you have been
  mixing routes, restart the session.

The full evidence — counts, the served control, the reproduction, and the
three explanations that turned out to be wrong — is in
[`docs/opencode-v2-prompt-defect.md`](./opencode-v2-prompt-defect.md),
along with why it has deliberately not been reported upstream. Found and
isolated by the Muster session.

### A known gap in the log

**Same-account** Claude↔Claude traffic goes through `SendMessage`, not Tin Can,
so **it does not appear in `~/.tincan/messages.jsonl`**. The log is a complete
record of what Tin Can carried, not of all agent-to-agent traffic on the
machine. That is the price of not duplicating a native feature, and it is
deliberate.

Claude↔Claude traffic *across* config dirs is Tin Can's, and is logged like any
other — `SendMessage` cannot reach those sessions, so there is no native path
being duplicated and no reason to stay out of the record.

There is no flag for any of this; `CLAUDE_CODE_MESSAGING_SOCKET` in the
environment decides which runtime is hosting.

## Peer names

A peer list can mix all three runtimes now (see
[Which peers you see](#which-peers-you-see)), but names still carry no runtime
prefix — a Codex thread and an opencode session sharing a slug collide and
both get suffixed, exactly as two same-runtime peers would.

- Display and input form: `auth-refactor`. Case-insensitive; any unambiguous
  prefix resolves (`auth` works if it is the only match).
- On a collision only, the suffixed form `auth-refactor.63a` is shown and
  required. Ambiguity is refused with every candidate listed — never guessed.
- **A short name is for a human typing.** Prefix matching has a sharp edge: once
  a session named exactly `muster` exits, `muster` is nobody's name and matches
  its neighbour `muster-b1` instead — delivered, and reported as sent. When your
  code already holds a session's durable id, address it by `canonical_id`, which
  is matched exactly and refuses rather than landing on a stranger. See
  [CANONICAL_ID.md](../CANONICAL_ID.md), known defect 4.
- A peer on another machine carries `@<machine>`: `auth-refactor@m4pro`. A peer
  on this one carries nothing, so every address in use keeps meaning what it
  meant. Collisions are counted per machine.
- Unnamed Codex threads have a `display_label` such as `billing-v2 · 963a`:
  the working directory's final component plus the last four ID characters.
  If the directory is unavailable, the runtime is used (e.g. `codex · 963a`).
  Listings show the full `thread_id` alongside these labels for copying.
  Their message address (`name`) remains `thread.63a`; use `name` with `send_peer`,
  not `display_label`. Named sessions use their existing address as the label.
- Canonical id, used in the log and envelope:
  `codex:auth-refactor.019b63ce-a33e-7ab1-80a0-bb7155040963a`. It carries the
  **whole** durable id, not the three-character suffix — that is what makes it
  unique, and a usable key. See [CANONICAL_ID.md](../CANONICAL_ID.md).

The suffix is the **last** three hex characters of the uuid. Codex thread ids are
UUIDv7, so every live thread on a machine shares the same leading characters and
a leading suffix would disambiguate nothing.

Claude peer names, cwd and idle/busy state come from `~/.claude/sessions/<pid>.json`.
Codex names are derived thread titles, slugified — so two threads titled
"Review phase 1" and "Review phase-1" collide, and both get suffixes. `/rename`
in the Codex TUI gives a thread a short stable name and avoids this entirely.

opencode peer names come from opencode's own stable `slug` (`nimble-wizard`),
never from its `title` — the title drifts as the conversation develops,
observed rewriting itself within two seconds of the first reply. A name that
changes underneath a caller mid-conversation would be worse than an opaque
one. An opencode session id is `ses_` followed by timestamp hex and base62
random; the same last-three-hex-characters rule applies and draws from the
random tail, for the same reason it does against Codex's UUIDv7.

Names belong to processes and die with them. Re-resolve through `peers` rather
than caching a name, and key durable records on the thread or session id.

> **[`CANONICAL_ID.md`](../CANONICAL_ID.md) is the normative specification** —
> exact slugify, suffix and resolution rules, the refusal shapes, and three known
> defects preserved in 0.1.0. Building a tool that must produce addresses Tin Can
> resolves? Read that and copy
> [`test/fixtures/canonical-id.json`](../test/fixtures/canonical-id.json).
