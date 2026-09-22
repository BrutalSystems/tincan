# Tin Can — Address Format

> **Normative for `@brutalsystems/tincan` 0.9.0.**
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

An address is built from two inputs:

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
| **Display** | `auth-refactor` | by `peers`, when the slug does not collide |
| **Qualified** | `auth-refactor.7f3` | by `peers`, only on collision |
| **Canonical** | `codex:auth-refactor.7f3` | as `canonical_id`, always |

The separator is `.` so that an address needs no shell quoting.

`canonical_id` is always fully qualified, whether or not there is a collision.
It is the form to record in logs and to pass between tools.

## Collision

A peer is suffixed in its **display** form when either:

- another peer in the same listing has the same slug, or
- the peer has no name (`rawName === null`), which is always suffixed.

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
  is unambiguous. The empty string is a prefix of everything — see
  [known defects](#known-defects).
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

**1. `canonical_id` is not unique.** Two peers whose slugs match *and* whose ids
share their last three hex characters produce the same `canonical_id`. Tin Can
then refuses to resolve either, listing two identical candidates — a refusal
that tells the caller to disambiguate using a string that does not
disambiguate. The peers are unaddressable until one exits.

Probability is roughly 1 in 4096 *given* a slug collision — slightly above
that for opencode ids, whose base62 tail skews the surviving hex (see
[Suffix](#suffix)) — and slug collisions are not rare: Codex titles threads
from their first prompt, so two sessions started from similar prompts collide
readily.

**Consumers must therefore treat `canonical_id` as a display and correlation
aid, not a primary key.** Key on `thread_id` / `session_id`.

**2. A name that slugifies to empty is inconsistent with an unnamed peer.**
Alone in a listing, a peer named `???` displays as `thread` with no suffix,
while a peer with no name displays as `thread.<suffix>`. Both slug to `thread`,
so when they appear together they collide and both are suffixed — the
inconsistency only shows when each is alone.

**3. The empty string resolves when exactly one peer exists.** Because the empty
string is a prefix of every slug, `resolve("")` against a single-peer listing
returns that peer rather than refusing. With two or more peers it is refused as
ambiguous, as expected.

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
