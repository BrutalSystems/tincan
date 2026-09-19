# Tin Can — Address Format

> **Normative for `@brutalsystems/tincan` 0.1.1.**
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
> **The implementation is authoritative.** If this document and Tin Can
> disagree, Tin Can is right and this document has a bug. The fixture is the
> regression net that keeps them together.

## The pieces

An address is built from two inputs:

| Runtime | Name source | Id source |
|---|---|---|
| `codex` | thread title, or absent | `thread_id` |
| `claude-code` | session name from the registry | `session_id` |

Neither name is guaranteed unique, and neither is stable: **a name belongs to a
process and dies with it.** Key durable records on the id, never on the address.

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

- `01a0b9b4-a33e-7ab1-80a0-bb715504a0fb` → `0fb`
- `5af69d42-2214-41d9-b13f-9c3177eb60ce` → `0ce`
- Uppercase hex is kept, then lowered: `...ABC` → `abc`
- Fewer than three hex characters yields a shorter suffix: `z-9` → `9`
- No hex at all yields an empty suffix: `zzzz` → `""`

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

## Resolution

Input is trimmed and lowercased, then matched in two passes.

**Pass 1 — exact.** Matches if the input equals the peer's display form, its
qualified form, or its canonical id. One match resolves. More than one is
refused as ambiguous.

**Pass 2 — prefix**, only if pass 1 found nothing. Matches if the peer's slug or
its qualified form *starts with* the input. One match resolves. More than one is
refused as ambiguous.

If neither pass matches, the result is refused as unknown.

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

Probability is roughly 1 in 4096 *given* a slug collision, and slug collisions
are not rare: Codex titles threads from their first prompt, so two sessions
started from similar prompts collide readily.

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

So:

- **A change to any behaviour described here is a breaking change**, and ships
  as a major version under semver.
- Update this document and the fixture in the same commit as the code.
- Adding cases to the fixture is not a breaking change. Changing an existing
  expected value is.

Fixing the known defects above is therefore a deliberate, coordinated release —
not a bug fix to be slipped in.
