# opencode: the v2 prompt route does not run the message

**Status: not reported upstream. Deliberate, decided 2026-09-20.** Tin Can
routes around it, the workaround is complete, and nobody is blocked. This file
exists so the evidence survives the decision — if it is ever filed, none of the
work below has to be done twice.

## The defect

`POST /api/session/{sessionID}/prompt` (opencode 1.18.31) on a **TUI-hosted**
session:

1. admits the message durably — it becomes a real `type:"user"` message
2. schedules an agent turn, about 70ms later
3. that turn dies before the agent runs, with `ModelUnavailableError` naming
   the session's own model
4. tells nobody

The endpoint's own OpenAPI summary promises *"Durably admit one session input
and schedule agent-loop execution unless resume is false."* Admission and
scheduling both happen. Execution does not.

## Why it is invisible

| Who could have learned the turn died | What they saw |
|---|---|
| The HTTP caller | 200 and an `admittedSeq`, already returned |
| The peer's session | nothing — no error is written into it |
| A human reading the session | a user message with no reply |
| `~/.local/share/opencode/log` | one `ERROR "Failed to drain Session"` line |

A turn that died is indistinguishable, from outside, from a turn that went
perfectly. That is what made this take three sessions to characterise.

## What is established, and what is not

**Established**, reproduced with neither Muster nor Tin Can in the path, by
direct `curl`: the 200, the `admittedSeq`, the drain about 68ms later, the
`ModelUnavailableError`, and that the TUI path resolves the same model string
in the same process seconds either side — observed on both providers. `opencode serve` runs the message.
v1 `prompt_async` runs the message.

**Not established:** *why* the drain fails. "It cannot resolve the model" is a
reading of an error string, not a claim from source — nobody read opencode's
model-resolution path the way its scheduling path was read. The scheduling
half is sourced; this half is inference from a log line.

Two loose ends, left loose deliberately:

- **A session that took a v2 failure appeared to stop running anything
  afterwards, v1 included.** Never isolated. If a v2 failure corrupts session
  state, then the 20 failures below are fewer independent events than the
  count suggests.
- **The `opencode serve` control differed in credentials as well as host
  type.** It is still the sharpest evidence, because the two failures are at
  different stages, but it is not a single-variable comparison.

## Evidence

- **14** distinct TUI-hosted sessions produced a `ModelUnavailableError` drain
- **20** such failures in total
- **2** unrelated providers — one a local model server, one a hosted API
- **0** TUI-hosted drains ever observed to succeed

The sharpest piece is the control, not the count. A session hosted by
`opencode serve` **also** failed in the same log on the same day — but with
`LLM.Error: RequestExecutor.execute: Provider request failed with HTTP 401`,
not `ModelUnavailableError`. It resolved the model and reached an HTTP request
to the provider, failing only on credentials that were never supplied.

So model resolution demonstrably succeeds in a served session and
demonstrably never succeeds in a TUI-hosted one, same machine, same day, two
different failures at two different stages.

A worked example, from our own logs:

Provider and model names are redacted to `<provider>/<model>`; both lines
named the same one, which is the point of the excerpt.

```
20:00:13.564  exiting loop                                  <- session goes idle
20:01:13.678  Tin Can delivers msg_26ba3415  (plugin log)
20:01:13.746  ERROR "Failed to drain Session"
              ModelUnavailableError: <provider>/<model>
20:02:54.617  loop ... stream <provider>/<model>            <- same model, works
```

## Three explanations that are wrong

Recorded because each one looked right, and because the symptom never changed
while the explanation did.

1. **"An idle session is never scheduled."** No. The drain starts ~70ms after
   admission. `session.ts` calls `execution.wake` unless `resume === false`,
   and the run coordinator starts a drain immediately when nothing is active.
2. **"The local model unloads when idle and is cold on arrival."** No. TUI
   success and drain failure alternate on the same model seconds apart; no
   cold start alternates like that.
3. **"It is an observability problem."** No. It is a hard functional failure;
   the invisibility is a second, separate problem on top of it.

## Reproduction, if it is ever filed

Stock opencode 1.18.31, no Muster, a globally authenticated provider:

1. Start a plain TUI in a detached tmux; let its first turn finish so it is idle.
2. `POST /api/session/{id}/prompt` with `{"prompt":{"text":"..."},"delivery":"queue"}`.
   It answers 200 with an `admittedSeq`.
3. `GET /api/session/{id}/message` — the **`/api/` path**; the v1 path returns a
   different view that omits injected messages entirely and will mislead you.
   The text is there as `type:"user"`; no assistant message ever appears.
4. `~/.local/share/opencode/log` carries `Failed to drain Session` with
   `ModelUnavailableError` at the delivery timestamp.
5. Control: the same POST against an `opencode serve` session resolves the
   model and runs the loop.

## What Tin Can does instead

The plugin posts to the v1 route, `POST /session/{id}/prompt_async`, which
goes through `SessionPrompt.Service` and simply runs the message. See the
README, "opencode: why the plugin posts to the v1 route". That change shipped
in 0.6.0 and the workaround is complete — which is precisely why filing is
optional rather than urgent.

The single most useful fact here is not the mechanism. It is that **the
failure is silent from the caller**: a success response, nothing written into
the session, and only a line in opencode's own log. That is what cost a day,
far more than the cause did.

Muster keeps its own record of this, scoped to sessions it launches rather
than to the endpoint — see `CONTRACT_PROVENANCE.md` there. Two records on
purpose: a maintainer here needs to know why delivery uses v1, and a
maintainer there needs to not re-derive the behaviour.

Credit: isolated by the Muster session, which supplied the three-way control
and the tmux reproduction that exonerated Muster's own process management.
