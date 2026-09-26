# How it works

The delivery mechanism for each runtime. None of this is needed to use
Tin Can; it is here because the adapters are where the hard parts live.

## How it works

Implementation notes, and the behaviour they were derived from. You do not need
any of this to use Tin Can.

### Codex: no daemon required

**No daemon and no control socket are required.** Tin Can spawns its own
short-lived `codex app-server --listen stdio://` and talks JSON-RPC to it over
stdio. Two things make that work:

- `initialize` must declare **`experimentalApi: true`**. The whole
  `thread/queue/*` family is gated on it; without the capability the daemon
  answers `-32600 … requires experimentalApi capability`.
- The queue is **shared state**, not per-process. A thread that is not loaded in
  our app-server still receives the submission, and a live Codex TUI polls for
  it. This is why no daemon is needed.

Watch out for two traps:

- `codex app-server generate-ts` **omits the experimental methods** from
  `ClientRequest`. `thread/queue/add` is absent from the generated bindings but
  present and working in the binary. Do not conclude from the generated types
  that a method does not exist.
- `codex app-server daemon start` requires the *standalone* install at
  `~/.codex/packages/standalone/current/codex`. An npm/asdf install has no such
  path and the command fails — which does not matter, because Tin Can does not
  use the daemon.

Two protocol calls genuinely are unusable from outside, and Tin Can avoids them:

- `thread/loaded/list` reports threads loaded in the *calling* process, so it is
  always empty for us. `thread/list` is the right call.
- `turn/steer` requires an `expectedTurnId` matching the peer's currently active
  turn, which only the connection owning that turn ever learns.

A consequence of that last one, for Codex specifically: **`urgent` has no
effect on a Codex peer** — nothing interrupts a running turn there, so every
message queues. (opencode is different — see below.) `peers` says so in its
output.

### Claude Code wire format

For anyone maintaining `src/claude/client.ts` — this was read from the 2.1.267
binary and verified by a live send. Two frames, one JSON object per line, then
close:

```json
{"type":"auth","peerToken":"<32 hex>","procStart":"...","pidDomain":"darwin"}
{"type":"user","message":{"role":"user","content":"..."},"priority":"next","msg_id":"msg_..."}
```

- The auth field is **`peerToken`**, read from `~/.claude/sessions/<pid>.<sha256>.key`.
  It is *not* `$CLAUDE_CODE_MESSAGING_TOKEN`, which holds a different value.
- A frame without a `type` field is silently ignored.
- Sockets live at `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, falling back to
  `/tmp/cc-socks/<pid>.sock` or `/tmp/cc-socks-<uid>/<pid>.sock`. The filename is
  the **pid**, not the session uuid.
- Connect only when the text is ready: Claude Code closes a connection that has
  not sent a complete line within 30 seconds.
- A held message comes back as a `peer_message_status` frame correlated by
  `orig_msg_id`. A hold is not a failure — it is surfaced as a notice.
- A **refused** message comes back the same way, and is not a notice. Claude
  Code's inbound controls end in one of three states — delivered, held, or
  refused — and a refusal means the receiver dropped the message without
  delivering it. Tin Can reports that as `failed` with `delivery_failed`, keeps
  the receiver's wording as the notice, and writes no idempotency record, so the
  same key can be used to retry. The peer is not marked unreachable: a session
  that refuses is alive, so the registry must not prune it.
- A status Tin Can does not recognise stays a notice and leaves the delivery
  reported as accepted. Treating an unfamiliar status as failure would report a
  delivered message as failed the first time a fourth state is added, and a
  caller acting on that would resend a message the peer already has.

### opencode: inverted reach

opencode's injection API is good on paper: `POST /api/session/{id}/prompt`
with an explicit `delivery: "steer" | "queue"`, durable in SQLite, idempotent
by message id. **None of it is reachable from outside.** A default `opencode`
TUI opens no TCP port — the server runs in a worker thread behind a nominal
base URL with an in-process fetch bridge, and there is no port file, lockfile,
PID file, or environment variable on disk that names it. An external `curl` to
the advertised URL is refused.

So the reach is inverted from the other two runtimes: instead of Tin Can
calling in, a plugin running *inside* opencode advertises each live session to
`~/.tincan/peers/opencode/` and binds a Unix socket (`0600`, one per opencode
instance, since one instance serves many sessions). Tin Can writes one JSON
object to that socket and closes; the plugin injects it as a prompt. Tin Can
never speaks HTTP to opencode, and the plugin — not `src/` — is what makes an
opencode session reachable at all. This is why opencode needs the second,
separate install: see [Install](./install.md#install).

Two things worth knowing if opencode's behavior ever seems to disagree with
this document:

- `delivery` must always be sent explicitly. opencode's own default is
  `"steer"`; Tin Can's policy is queue-by-default. Omitting the field would
  silently invert that policy with no error.
- Re-submitting an already-seen `message_id` returns success with the
  original result, not an error — opencode's idempotency, not a retry Tin Can
  performs itself.
