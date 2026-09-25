# Tin Can — Address Format

> **Normative for `@brutalsystems/tincan` 1.9.2.**
>
> This describes what Tin Can does today, precisely enough for another tool to
> produce addresses Tin Can will resolve. It is a write-down of shipped
> behaviour, not a design. Where the behaviour is wrong, it is marked **Known
> defect** and preserved anyway — see [Known defects](#known-defects).
>
> The executable form is [`test/fixtures/canonical-id.json`](test/fixtures/canonical-id.json),
> asserted by `test/canonical-id.test.ts`. Copy that fixture rather than
> reimplementing from prose.
>
> Its `tincan_version` field records the release the expectations were verified
> against, and is bumped every release. **A version difference alone is not
> drift** — compare the file's contents, or its hash, to tell whether the format
> actually moved.
>
> **The implementation is authoritative.** If this document and Tin Can
> disagree, Tin Can is right and this document has a bug. The fixture is the
> regression net that keeps them together.

## The pieces

An address is built from three inputs, one of which is usually absent:

| Runtime | Name source | Id source |
|---|---|---|
| `codex` | thread title, or absent | `thread_id` |
| `claude-code` | session name from the registry | `session_id` |
| `opencode` | session slug | `session_id` |

Neither name is guaranteed unique, and neither is stable: **a name belongs to a
process and dies with it.** Key durable records on the id, never on the address.

`peers` exposes that id on every peer — `thread_id` for Codex, `session_id` for
Claude Code and for opencode — so a caller never has to derive it from an
address.

The third input is the **machine**, and it is absent for every peer on this
one. See [Machine](#machine).

## Machine

A peer on another machine carries `@<machine>` at the end of its address. A
peer on this machine carries nothing.

    auth-refactor            a session here
    auth-refactor@m4pro      a session on another computer

Absent rather than a literal like `localhost`, for two reasons. Every address
anyone types today keeps working and keeps meaning exactly what it meant. And
it makes the dangerous direction the explicit one: reaching another computer
requires saying so.

**A bare address never resolves to a remote peer.** Resolution filters by
whether the input contains `@` before matching anything, so an address with no
machine can only match a local session — including during prefix matching,
which is where it would otherwise slip through. A message meant for a local
peer must not leave the machine because a local session happened to exit.

The machine name is slugified by the same rule as a peer name.

## Slugify

Applied to the runtime-supplied name.

1. Lowercase the whole string.
2. Replace every run of characters outside `[a-z0-9]` with a single `-`.
3. Strip leading and trailing `-`.

Consequences worth stating, because they are easy to get wrong:

- **Non-ASCII is a separator, not transliterated.** `café ☕ time` → `caf-time`.
- Runs collapse: `auth/refactor (v2)` → `auth-refactor-v2`.
- Digits survive: `123` → `123`.
- **The result may be empty.** `???` → `""`, `""` → `""`.

An empty slug is replaced by the literal `thread`. This applies both to a peer
with no name at all and to a peer whose name slugifies away — which is where a
[known defect](#known-defects) lives.

## Suffix

Applied to the id.

1. Remove every character outside `[0-9a-f]`, case-insensitively.
2. Take the **last three** characters of what remains.
3. Lowercase.

**The last three, not the first.** Codex thread ids are UUIDv7: the leading hex
is a timestamp, so every thread live on a machine at the same time shares its
first characters. A leading suffix disambiguates nothing. This has been
specified wrongly before — verify against the fixture.

The same holds for opencode, for the same reason by a different route. An
opencode session id is `ses_` followed by roughly twelve hex characters of
descending timestamp, then roughly fourteen base62 (`[0-9a-zA-Z]`) random
characters. Stripping to `[0-9a-f]` and taking the last three lands in that
random tail, not the timestamp — exactly as it does for a Codex UUIDv7 or a
Claude Code UUIDv4. `suffixOf('ses_f41a2b3c4ffeExampleSess01Z')` → `'e01'`.

- `01a0b9b4-a33e-7ab1-80a0-bb715504a0fb` → `0fb`
- `5af69d42-2214-41d9-b13f-9c3177eb60ce` → `0ce`
- `ses_f41a2b3c4ffeExampleSess01Z` → `e01`
- Uppercase hex is kept, then lowered: `...ABC` → `abc`
- Fewer than three hex characters yields a shorter suffix: `z-9` → `9`
- No hex at all yields an empty suffix: `zzzz` → `""`

Two caveats specific to opencode's id shape:

- **The random tail is base62, not hex, so filtering it down to `[0-9a-f]`
  skews the alphabet.** `a`–`f` are reachable from two source characters each
  (upper- and lower-case), while `0`–`9` are reachable from only one, so the
  surviving hex digits are not uniform. Collision odds for the suffix
  therefore sit slightly above the nominal 1 in 4096 for a uniform 3-hex-digit
  space. Worth stating; not worth changing — see
  [Changing this format](#changing-this-format).
- **An opencode id can never produce the empty-suffix defect.** The fixed
  `ses_` + hex-timestamp prefix guarantees at least three hex characters are
  always present, so unlike an adversarial or degenerate id (`zzzz` above),
  `suffixOf` never returns `""` for a real opencode session id.

## Forms

Three forms exist. Two are emitted; all three are accepted as input.

| Form | Shape | Emitted |
|---|---|---|
| **Display** | `auth-refactor`, `auth-refactor@m4pro` | by `peers`, when the slug does not collide |
| **Qualified** | `auth-refactor.7f3`, `auth-refactor.7f3@m4pro` | by `peers`, only on collision |
| **Canonical** | `codex:auth-refactor.01a0b9b4-a33e-7ab1-80a0-bb715504a0fb` | as `canonical_id`, always |

**The canonical form carries the whole durable id**, not the three-character
suffix. That is what makes it unique — see [Known defects](#known-defects),
where its non-uniqueness used to be recorded as a defect preserved on purpose.

The separator is `.` so that an address needs no shell quoting.

`canonical_id` is always fully qualified, whether or not there is a collision.
It is the form to record in logs and to pass between tools.

**Do not recover the suffix from a canonical id by string surgery.** Taking the
last dot-separated segment gave the three-character suffix before 1.0.0 and
gives the whole durable id now — `01a0b9b4-a33e-7ab1-80a0-bb715504a0fb`, not
`0fb`. A reimplementation that does this builds qualified addresses that look
right and match nothing, and the failure surfaces as `unknown`, which names a
missing peer rather than a malformed address. Reported by muster, where it made
every `slug.suffix` address fail silently until a test was written for it.

Derive the suffix from the **uuid**, with `suffixOf` — the last three hex
characters of the id with non-hex removed. The canonical form is an address to
pass along whole, not a record to parse fields out of.

## Collision

A peer is suffixed in its **display** form when either:

- another peer in the same listing has the same slug **on the same machine**, or
- the peer has no name (`rawName === null`), which is always suffixed.

Collisions are counted per machine. The same slug on two computers is already
two different addresses, so suffixing both would add noise to distinguish
things that were never confusable.

Otherwise the display form is the bare slug. Only colliding peers are suffixed;
peers that do not collide keep their bare names in the same listing.

**Adding a runtime can change an existing peer's display.** `assignNames`
computes collisions across the *whole* returned list, regardless of runtime.
So a peer that displayed as a bare slug before opencode support existed can
start displaying suffixed the moment an opencode peer (or any peer) slugging
to the same string appears in the same listing — a Codex peer `foo` and an
opencode session slugging to `foo` both flip from bare `foo` to qualified
`foo.<suffix>` (see the fixture's "cross-runtime collision" case). This is
inherent to the existing rule, not new behaviour introduced by opencode
support, and it is correct: the two peers are genuinely indistinguishable by
slug. It is called out here because Muster consumes `display`, and this
should be an expected consequence of adding a runtime, not something its
maintainer discovers by surprise.

## Resolution

Input is trimmed and lowercased, then matched in two passes against the peer
listing, with one host-local check between them.

**Pass 1 — exact.** Matches if the input equals the peer's display form, its
qualified form, or its canonical id. One match resolves. More than one is
refused as ambiguous.

**Self check**, only if pass 1 found nothing. If the input names the session
Tin Can is itself running in, the result is refused as `self`. See
[Self is not a peer](#self-is-not-a-peer) — this pass is **not** part of the
fixture contract and a second implementation is not expected to reproduce it.

**Pass 2 — prefix**, only if pass 1 and the self check found nothing. Matches
if the peer's slug or its qualified form *starts with* the input. One match
resolves. More than one is refused as ambiguous.

If nothing matches, the result is refused as unknown.

### Self is not a peer

A host never lists the session it is running in, so an address naming that
session reaches pass 2 with nothing to match — or, worse, matches *something
else*. The check sits between the passes rather than before them, and the
order is load-bearing in both directions:

- **Below pass 1**, so an exact peer name still wins. A peer genuinely called
  `review` receives `review` even when the host is called `review-tools`,
  which the self check matches by prefix.
- **Above pass 2**, because that pass resolves on a *single* match. A host
  that can only recognise itself by name — a Claude Code host carries no
  session id of its own and falls back to its working directory's basename —
  whose fallback name prefixed exactly one peer would otherwise resolve to
  that peer and deliver. Where the listing spans config dirs, that peer
  belongs to a different account: a note addressed to yourself, delivered to
  a stranger, reported as sent.

**This is deliberately outside the fixture.** Every case in
`test/fixtures/canonical-id.json` resolves with no host identity supplied, and
all ten behave identically with and without this pass. "Self" is a property of
the process doing the resolving, not of the address or the listing, so a tool
that consumes addresses — Muster launches sessions and hands back peer records
for Tin Can to resolve — has no self to check and nothing to implement. The
address format is unchanged; what changed is what one particular resolver does
with its own name.

- **Case-insensitive** throughout. `AUTH-REFACTOR.7F3` resolves.
- **Input is trimmed.** Surrounding whitespace is ignored.
- **There is no minimum prefix length.** A one-character prefix resolves if it
  is unambiguous. The empty string is a prefix of everything, and a complete
  name can be a prefix of a longer complete name — see
  [known defects](#known-defects), 3 and 4.
- **No tie-breaking.** Ambiguity is always refused, never guessed.

### Refusal shape

| Reason | `candidates` contains |
|---|---|
| `ambiguous` | every matching peer, in **qualified** form |
| `unknown` | every peer in the listing, in **display** form |
| `self` | every peer the address *also* prefixed, in **qualified** form — so the caller is told which full name to type instead of guessing one exists |

## Known defects

Preserved by decision, not by oversight. They are in the fixture so
that a second implementation matches Tin Can exactly, including where Tin Can is
wrong. **Do not "correct" them independently** — that produces addresses that
resolve in one tool and fail silently in the other.

**1. `canonical_id` is not unique. — FIXED in 1.0.0.**

It used to carry the three-character suffix, so two peers whose slugs matched
*and* whose ids shared their last three hex characters produced the same
`canonical_id`. Tin Can then refused to resolve either, listing two identical
candidates — a refusal that told the caller to disambiguate using a string that
did not disambiguate. Both peers were unaddressable until one exited. Roughly 1
in 4096 given a slug collision, and slug collisions are not rare: Codex titles
threads from their first prompt.

The canonical form now carries the whole durable id, which makes a collision
impossible rather than merely unlikely. Both peers stay addressable.

**The short forms still collide**, and still should: `display` and `qualified`
are for humans, and two sessions genuinely sharing a name are genuinely
ambiguous. The difference is that there is now an unambiguous form to fall back
to. `canonical_id` is a usable key.

**2. A name that slugifies to empty is inconsistent with an unnamed peer.**
Alone in a listing, a peer named `???` displays as `thread` with no suffix,
while a peer with no name displays as `thread.<suffix>`. Both slug to `thread`,
so when they appear together they collide and both are suffixed — the
inconsistency only shows when each is alone.

**3. The empty string resolves when exactly one peer exists.** Because the empty
string is a prefix of every slug, `resolve("")` against a single-peer listing
returns that peer rather than refusing. With two or more peers it is refused as
ambiguous, as expected.

**4. A full name that is a prefix of a longer full name resolves to the longer
one once the exactly-named session is gone.** While a session named `muster` is
listed, `muster` is an exact hit and pass 2 is never reached. The moment it
exits, `muster` is nobody's name and becomes merely a prefix of its neighbour
`muster-b1` — the only match, so it resolves, and the message is delivered to a
session the caller did not mean and reported as sent. Observed live between two
sessions; the send was a reply, so `reply_misrouted` caught it, but a new
message would have gone through.

This is not an exotic collision. It happens whenever a short name and a longer
one built on it coexist — `muster` / `muster-b1`, `ferry` / `ferry-9b`.

**It is kept because it cannot be fixed from the listing alone.** The hazard is
indistinguishable from the behaviour directly above it in this document: `auth`
→ `auth-refactor` and `muster` → `muster-b1` are the same shape, the same single
match, and in both cases the input is nobody's current name. The only fact that
separates them is that a session named exactly `muster` *existed and has gone*,
and a peer listing cannot carry that fact, because the session's absence is the
whole premise. Any rule that refuses the second refuses the first: removing the
prefix pass is verifiable in one edit, and it fails
`resolve > unambiguous prefix resolves` alongside the defect's own case.

**The form that cannot misroute is `canonical_id`.** Pass 2 matches against the
slug and the qualified form, never against `canonicalId`, so a canonical id can
never prefix-match a stranger — it resolves to the session it names or refuses
as unknown:

```
muster gone , resolve("muster")                        -> OK, muster-b1
muster gone , resolve("claude-code:muster.18ddaa21-…") -> REFUSED unknown
```

A loud refusal is the outcome a caller wants here. **When you hold a session's
durable id, address it by `canonical_id` rather than by its bare name** — a
short name is for a human typing, not for a program that already knows exactly
which session it means. `expect_id` does not substitute: it is compared after
resolution and only ever rejects, so it guards the send without selecting the
recipient.

## Changing this format

The address format is a contract between Tin Can and tools built against it. A
change to slugify, suffix derivation, collision handling, or resolution produces
addresses that resolve in one tool and fail silently in the other — no error,
just a message delivered nowhere.

**Who is built against this today:**
[Muster](https://github.com/BrutalSystems/muster) launches agent sessions and
returns a peer record Tin Can must resolve. It does not import Tin Can — the two
agree on this document and on `test/fixtures/canonical-id.json`, which Muster
copies verbatim. So a change here is not local to this repo, and the person
making it is responsible for coordinating the release, not for discovering
afterwards that the other tool disagreed.

So:

- **A change to any behaviour described here is a breaking change**, and ships
  as a major version under semver.
- Update this document and the fixture in the same commit as the code.
- Adding cases to the fixture is not a breaking change. Changing an existing
  expected value is.

Fixing the known defects above is therefore a deliberate, coordinated release —
not a bug fix to be slipped in.
