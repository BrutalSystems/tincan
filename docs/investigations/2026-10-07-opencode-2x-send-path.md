# opencode 2.x: does sending from a 2.x session work?

**Status:** closed — root cause found and fixed in 2.3.1 (`7f058a9`); 2.x↔2.x send and reply verified.

## Question

After 2.3.0 (#46) made the plugin — the *receive* half — work on opencode 2.x,
Mike approved checking the *send* half: "Sending from an opencode 2.x session
is untested" (follow-up 1 of 4 after #46, 2026-10-07). `docs/install.md` tells 2.x users
to register Tin Can under `mcp.servers`, based on 2.0.24's config schema only.

## Context

- tincan 2.3.0 (`c3c5798`), installed globally on this machine.
- opencode 2.0.24 (`@opencode/cli`), run from a scratchpad install with HOME,
  XDG_* and TINCAN_HOME all isolated; never Mike's real config.
- Model: a local fake OpenAI-compatible server (`fake-llm2.mjs`) that answers
  "OK", logs the tools it is offered, and calls `*send_peer` when the newest
  user message says `SENDTEST <peer>`.
- opencode 2.x runs a shared background service by default; `opencode run`
  connects to it. `--standalone` runs a private server per command.

## What was checked

- `mcp: { tincan: {…} }` (1.x shape) → `opencode mcp list` prints "No MCP
  servers configured". *Confirmed:* 2.x ignores the 1.x shape silently.
- `mcp: { servers: { tincan: { type: "local", command: [...] } } }` →
  `✓ tincan connected`. *Confirmed.*
- MCP command via the asdf `node` shim under an isolated HOME exits 126 —
  sandbox artefact (the shim needs the real HOME); use the absolute node path.
- Tools offered to the model, default codemode: on a session's first turn,
  `… write, execute` — no `tincan_*`. *Seen once, on a cold service only.*
- With `codemode: false` on the tincan server, on a warm service:
  `tincan_message_log, tincan_peers, tincan_reregister, tincan_send_peer`.
- Repeated hangs (`opencode run` never returns, no request reaches the model).
  Correlated with: killing the fake model server while the service ran;
  editing opencode.json while the service ran; a project whose history held
  sessions interrupted mid-turn. Removing the tincan plugin did not prevent
  one. **Cause found: stdin.** `opencode run` reads piped stdin and waits for
  EOF; the shell's stdin was sometimes an open pipe. With `< /dev/null` every
  run returns. None of the hangs were opencode's or Tin Can's — and the 1.x
  "hangs" earlier in the day were the same thing.
- Clean rebuild (fresh HOME, one fake model, `service stop` only): with
  default codemode the model is offered only `execute`; the Code Mode catalog
  in the system prompt lists `tools.tincan.send_peer(...)` etc.
- Send through `execute` (codemode on): delivered to the 2.x peer, and the
  plugin's `tool.execute.before` DID fire with `tool: "tincan_send_peer"` —
  caller record written with the right session. Codemode is not a problem.
- But the envelope said `from="tincan-65" runtime="claude-code"` — the
  Claude Code session that started the sandbox. The MCP process's environment carried every CLAUDE_*
  variable from the shell that started the service, and **no OPENCODE***
  variable at all. `detectRuntime` (`src/runtime.ts:91`) keys on
  `OPENCODE`/`OPENCODE_PID`, so it fell through to Claude Code.
- MCP process's parent pid == the 2.x service pid == the `pid` on every
  plugin record and caller ticket.
- Control, released 2.3.0, clean environment (`env -i`): tincan believed it
  was Codex — `peer_unknown`, "No usable `codex` on PATH". Every send from a
  2.x session fails for a normal user.
- Fix (2.3.1): `src/opencode/host.ts` walks ancestors when the variables are
  missing and supplies them from the first `opencode`. Clean environment:
  `from="happy-tiger" runtime="opencode"` with alpha's session id, and a reply
  to `happy-tiger` from beta was delivered to that same session.

## Findings

- *Confirmed:* 2.x MCP config shape is `mcp.servers`; the 1.x shape is ignored
  with no error.
- *Confirmed:* default codemode hides MCP tools behind `execute`, but the
  tool hook still reports `tincan_send_peer`, so caller identification works.
- *Confirmed, root cause:* opencode 2.x sets no `OPENCODE`/`OPENCODE_PID` for
  MCP servers; `detectRuntime` (`src/runtime.ts:91`) then picks codex (or
  claude-code with a leaked environment). Fixed by `src/opencode/host.ts`.

## Options

1. Docs-only 2.3.1 with what is confirmed, plus an issue for the send path.
2. Rebuild the sandbox cleanly and test a real send (chosen).
3. Ask the #46 reporter, who runs 2.x with Tin Can.

## Decision

2026-10-07, Mike: option 2. Fix and 2.3.1 cut were within the approved item ("if it needs a code change, that ships as a 2.3.1 cut").

## Next steps

None for this question. Not covered: two directories calling Tin Can at the
same moment in one 2.x service (tickets share the service pid; `self.ts`
answers `undefined` on real ambiguity, which excludes rather than misnames).
Sandbox recipe, if needed again: isolated HOME/XDG/TINCAN_HOME, absolute node
path in the MCP command, `< /dev/null` on every `opencode run`, and an
`env -i` wrapper to mimic a normal terminal.
