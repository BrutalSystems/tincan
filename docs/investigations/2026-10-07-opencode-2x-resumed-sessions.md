# opencode 2.x: resumed sessions are never advertised

**Status:** closed — fixed in 2.4.0 (plugin remembers names); upstream request anomalyco/opencode#53779.

## Question

Follow-up 4 of 4 after #46 (2026-10-07), approved by Mike: "A resumed opencode session
can't be messaged until it does something" — try 2.x's `session.viewed` to
advertise a session as soon as it is opened.

## Context

- tincan 2.3.1 (`4ef4272`); opencode 2.0.24 in the scratchpad sandbox
  (isolated HOME/XDG/TINCAN_HOME, fake model, `< /dev/null` on every run —
  see `2026-10-07-opencode-2x-send-path.md` for the recipe).
- The plugin builds a registry record — and so a peer address — from the
  session's `slug`. On 1.x every `session.updated` carries the full session
  including `slug`, so a resumed session becomes addressable on its next
  activity (SPEC §5, "On load: advertise nothing").

## What was checked

- `session.viewed` (2.x types): `data: { sessionID, idle }` — a read receipt
  ("idle watermark the viewer observed"), not a "session opened" signal. No
  slug, no directory.
- 2.x `SessionInfo` (types): no `slug` field. Runtime confirms it:
  `opencode api GET /api/session` → keys `cost, id, location, outcome,
  projectID, time, title, tokens`; `slug` absent on all 26 sessions.
- The slug exists only on the `session.created` event. The full 2.x client has
  `session.log` (the durable event log, which holds that event), but the
  plugin context's `session` domain is a `Pick` without `log`, `export` or
  `list` — not reachable from a plugin.
- Repro: session `kind-tiger` advertised; `opencode service stop` (registry
  emptied by the plugin's cleanup, as designed); `opencode run --session
  <its id> "say ok again"` — a full turn ran; registry: **0 records**, and the
  session never appears.

## Findings

- *Confirmed:* on 2.x a session created before the background service last
  started is never advertised, whatever it does — no event after
  `session.created` carries the slug, and the plugin cannot ask for it. Any
  service restart (a reboot) triggers it. Worse than 1.x, where activity
  recovers it.
- *Confirmed:* `session.viewed` cannot fix this on its own — it has no slug.

## Options

1. **Remember slugs on disk (recommended).** On every `session.created` the
   plugin also writes `session_id → slug` to a small file of its own under
   `~/.tincan/peers/opencode/`. On activity from a session it does not know
   (`execution.started`, `renamed`, `viewed`, an inbox event) it looks the slug
   up, asks `ctx.session.get` for directory and title, and advertises it if the
   directory is its own. Entries removed on `session.deleted`; size capped.
   Covers every session created while 2.4.0+ was installed; older ones stay
   invisible. 2.x only; minor release (2.4.0). Cost: a new on-disk file, ~1–2
   hours with tests and a sandbox repro.
2. **Document it as a known limitation** in the plugin README and SPEC §5.1,
   and file an upstream request for `slug` on `SessionInfo`. Cheap; leaves
   every 2.x user losing peers on each reboot.
3. **Address resumed sessions by something other than slug** (title, id). An
   address-format change — a **major** release per RELEASING.md. Not
   recommended.

## Decision

2026-10-07, Mike: option 1, after first checking for a cleaner source of the slug (none: `ctx.rpc` is for a plugin's own calls; v1 `/session` routes return the web app; `GET /api/session/{id}` has no slug; the event stream cannot replay) and filing upstream in parallel. Shipped as 2.4.0; filed anomalyco/opencode#53779.

## Next steps

None. Verified in the sandbox on 2.0.24: create → service stop → `run --session`
re-advertised the session under its original slug, and `tincan send` to it
arrived as a turn. When #53779 lands, `names.ts` can be replaced by reading
`slug` from `ctx.session.get`. Still invisible: sessions created before 2.4.0,
and a resumed session with no activity yet.
