# Tin Can — opencode Plugin, Build Spec

> For a coding agent. This is the build instruction, and it **supersedes
> Implementation Handoff Rev 1** wherever the two disagree.
>
> Owner: Mike Williams · Rev 2, 2026-09-20
>
> Rev 1 was written against the published docs and the SDK type definitions.
> Rev 2 is written against the running program. Every claim below marked
> **[verified]** was observed on a real `opencode` TUI on this machine; see
> [Appendix A](#appendix-a--what-was-verified-and-how).
>
> Verified against **opencode 1.18.31** (Bun 1.3.14 embedded). Pin that version
> in the README.
>
> This document is authoritative for the wire format and the registry layout.
> The Tin Can — Change Notice §6 defers to it.

---

## 1. What you are building

A small opencode plugin that makes live opencode sessions addressable by Tin Can.

**A default `opencode` TUI opens no TCP port at all.** [verified] It runs its
server in a worker thread behind a nominal base URL with an in-process fetch
bridge. There is no port file, lockfile, PID file or environment variable
anywhere. Nothing outside the process can find it.

> Two stale claims to ignore. The published docs at <https://opencode.ai/docs/server/>
> say the TUI "randomly assigns a port and hostname" — wrong. Rev 1 of this
> handoff said the nominal URL is `http://opencode.internal` — also wrong. In
> 1.18.31 `input.serverUrl` reports **`http://localhost:4096/`**, which is
> simply the SDK's generated default `baseUrl`. Nothing listens there:
> an external `curl` is refused and the process holds no LISTEN socket.
> [verified]

The plugin closes the gap from the inside. It runs within opencode, so it can
reach the server through the client it is handed, regardless of ports. Its job
is three things:

1. **Advertise** live sessions into `~/.tincan/peers/opencode/`
2. **Accept** inbound messages on a Unix socket and inject them
3. **Report** session state, pushed from opencode's event bus

Tin Can never speaks HTTP to opencode. **There is no port-based fallback** —
one code path, and if the plugin is not installed there are simply no opencode
peers.

---

## 2. Stack and layout

No framework, no build step — a `.ts` file loads and runs as-is. [verified]
Rev 1 asked for a single file; the loader's behaviour (see *Export shape*
below) makes that impossible without giving up unit tests, so the shape is one
globbed entry file plus a `tincan-lib/` directory the loader ignores.

```
tincan/
  plugins/
    opencode/
      SPEC.md            # this document
      tincan.ts          # the plugin — the ONLY globbed file, one export
      tincan-lib/        # helpers; never globbed, freely importable by tests
      README.md          # install, uninstall, troubleshooting
      test/
```

**Zero runtime and zero build dependencies. Do not depend on
`@opencode-ai/plugin`, not even for types.** Rev 1 called for it; the probes
found its published types disagree with the 1.18.31 runtime in both directions
— they declare a `client.v2` that does not exist, and omit a `slug` that does.
Hand-write the handful of types you need in `tincan-lib/types.ts`. Zero
dependencies also keeps the deliverable something the user copies in by hand,
which §8.5 depends on.

### Install location

The loader globs `{plugin,plugins}/*.{ts,js}` — one level deep, both spellings
accepted, in the global config dir and in a project's `.opencode/`. [verified]
Document `~/.config/opencode/plugin/tincan.ts` as the install path and mention
`plugins/` is equally valid. The helper directory is name-spaced rather than
called `lib/` because `plugin/` is shared with every other opencode plugin.

### Export shape — get this right or the plugin silently does nothing

Three shapes load: a named export, `export default async function`, and
`export default { id, server }`. [verified]

**But if the module's `default` export looks like a v2 plugin — an object with
`{ id, setup }` — the loader takes the v2 branch and silently ignores every
named export in the file.** No error, no log. The first probe hit exactly this
and it read as "the legacy plugin API has been removed."

**Worse: the loader invokes _every_ exported function as a plugin.** A probe
exporting a pure helper `composeRecord(a, b)` alongside the real plugin saw
that helper called with `a = <PluginInput>, b = undefined`. [verified] So the
globbed file cannot export test helpers.

Use a single named export, and no default export of any kind:

```ts
export const TinCan = async (input: PluginInput): Promise<Hooks> => { … }
```

**Helpers live in a `tincan-lib/` subdirectory.** The glob is one level deep, so
`plugin/tincan-lib/*.ts` is never loaded as a plugin [verified] while still being
importable by `tincan.ts` and by tests. This is what makes the code unit-
testable at all, and it is why the install is a small directory rather than
Rev 1's single file.

---

## 3. Reaching the server

`input.client` is the **v1 SDK client only**. There is no `client.v2`;
`"v2" in input.client` is `false` at runtime. [verified] Rev 1's
`client.v2.session.prompt()` does not exist and must not be used.

Global `fetch` is **not** bridged. `fetch("http://localhost:4096/session")`
throws *"Unable to connect. Is the computer able to access the url?"* — with a
URL, with a `Request`, either way. [verified]

The bridge lives on the client's internal transport, and reaching it requires
the private `_client` field:

```ts
const transport = (input.client as any)._client   // hey-api client
await transport.post({ url: "/api/session/…/prompt", body: { … } })
```

`transport.getConfig().fetch` is a distinct function, not `globalThis.fetch`,
and calling it directly with a `Request` also works. [verified] Both routes go
through `_client`, so **the private-field dependency is unavoidable.** Isolate
it behind one function, at the top of the file, with a comment saying why.

### The v2 API lives under `/api/`

This is the correction that matters most. v1 routes are unprefixed; v2 routes
are prefixed `/api/`. Pulled from the server's own OpenAPI document, which it
serves at `GET /doc` (479 KB). [verified]

| What Rev 1 called | Actual route | Operation |
|---|---|---|
| `client.v2.session.prompt()` | `POST /api/session/{sessionID}/prompt` | `v2.session.prompt` |
| `client.v2.session.active()` | `GET /api/session/active` | `v2.session.active` |
| `client.session.list()` | `GET /session` | `session.list` (v1, all history) |

### An unknown route returns 200 with HTML

`POST /session/{id}/prompt` — the same path without `/api` — returns **200 and
the SPA's `<!doctype html>`**. [verified] Unknown paths fall through to the
static web UI. A wrong path looks exactly like success.

**Never trust the status code alone.** Every response must be checked for a
JSON body of the expected shape before it counts as delivered.

### Startup self-check

At load, before advertising anything, call `GET /api/session` through the
transport. A healthy server returns 200 with `{ data, cursor }`. [verified]

If that check fails — `_client` missing, `post` not a function, HTML body,
throw — **log once and advertise nothing.** A registry entry the plugin cannot
deliver to is worse than no entry. Do not bind the socket either.

---

## 4. Registry layout

Everything lives under `~/.tincan/peers/opencode/` (honour `TINCAN_HOME`).
Create the directory mode **`0700`**.

**One socket per opencode instance**, not per session:

```
~/.tincan/peers/opencode/inst-<instance-id>.sock
```

`<instance-id>` is a short random string generated at plugin load. It
identifies the process, not the project.

**Use `node:net`, not `Bun.listen`.** Both work inside the Bun worker, but
`node:net` binds, accepts an outside connection, and reads a newline-framed
line just as well [verified] — and being a pure Node API, it makes the socket
server testable under the repo's existing vitest without a Bun test runner.
One code path, one runner.

**Neither API gives you `0600` for free.** `Bun.listen({ unix })` creates the
socket `0755` [verified]; `node:net` does the same. `chmodSync(path, 0o600)`
immediately after `listen` works and is verified against both. The `0700`
parent directory closes the window between bind and chmod, which is why it is
not optional.

**macOS caps `AF_UNIX` paths at ~103 bytes** — 102 binds, 106 fails with
`AF_UNIX path too long`. [verified] The default path is ~56 bytes and fine, but
a deep `TINCAN_HOME` breaks bind. Check the length before binding and log a
clear error rather than letting the bind throw.

**One JSON file per live session**, rewritten when state changes:

```
~/.tincan/peers/opencode/<session-id>.json
```

```json
{
  "session_id": "ses_f4185535affe0nxzk66nw19ihJ",
  "slug": "nimble-wizard",
  "title": "auth refactor",
  "directory": "/Users/mike/Source/brutalsystems/billing",
  "state": "idle",
  "socket": "/Users/mike/.tincan/peers/opencode/inst-a91f.sock",
  "instance_id": "inst-a91f",
  "pid": 41233,
  "plugin_version": "0.4.0",
  "opencode_version": "1.18.31",
  "updated_at": "2026-09-19T14:02:11Z"
}
```

- `slug` is opencode's own human-friendly name (`nimble-wizard`). **Prefer it
  over `title`** — the title drifts as the conversation goes on, and a peer
  name that changes underneath a caller is worse than an opaque one. Include
  `title` anyway; Tin Can may show it.
- `state` is `idle` | `busy`, mapped in §5. **There is no `unreachable`.** The
  plugin can never observe its own unreachability — by the time it would apply,
  the plugin is gone. Unreachability is Tin Can's to infer from a refused
  socket and cache in its own view.
- `pid` lets Tin Can tell a crashed instance from a live one.

**Write atomically** — temp file in the same directory, then rename. Tin Can
reads these at arbitrary times and must never see a partial one.

### One caller file per instance

```
~/.tincan/peers/opencode/inst-<instance-id>.caller.json
```

```json
{
  "instance_id": "inst-a91f",
  "session_id": "ses_f4185535affe0nxzk66nw19ihJ",
  "pid": 41233,
  "tool": "tincan_send_peer",
  "at": "2026-09-19T14:02:11Z"
}
```

This exists for one reason: **Tin Can hosted inside opencode as an MCP server
cannot otherwise tell which session is calling it**, and therefore cannot
exclude itself from its own peer list. opencode exports no
`OPENCODE_SESSION_ID` into tool subprocesses, and `pid` ancestry identifies only
the *instance* — one instance commonly runs several sessions in one directory.

The `tool.execute.before` hook does carry the calling `sessionID`, including for
MCP-provided tools. [verified] The plugin writes this file whenever a tool whose
id ends in `_peers`, `_send_peer` or `_message_log` executes.

**Match the suffix, never a `tincan_` prefix.** opencode names an MCP tool
`<server key>_<tool name>`, and the server key is whatever the user wrote in
their own opencode config. A probe registered as `probe` exposing `probe_ping`
produced the tool id `probe_probe_ping`. [verified]

Session records are always `ses_*.json`, so a reader can tell the two apart by
name. The caller file carries `instance_id`, so it is removed by the same
`dispose` and orphan-sweep paths as everything else.

---

## 5. Event handling

Subscribe via the `event` hook. Every session lifecycle event fires in a
default TUI. [verified]

| Event | Action |
|---|---|
| `session.created` | Write the registry file, `state: "idle"` |
| `session.updated` | Rewrite the file (title, directory may have changed) |
| `session.deleted` | Delete the file |
| `session.idle` | `state: "idle"` |
| `session.status` | Map `status.type`: `idle`→`idle`, `busy`/`retry`→`busy` |

**`slug` is on the event payload** at `properties.info.slug`, even though the
published v1 `Session` type omits it. [verified] No extra fetch is needed.

**`session.status` carries exactly three variants** — `idle`, `busy`, `retry`
— confirmed against the live OpenAPI schema, not the SDK types. [verified]
Nothing else exists, so the mapping above is total. `retry` additionally
carries `attempt`, `message`, `action`, `next`; collapsing it to `busy` is
correct for v1, and noted in §10 as a thing we may want to surface later.

**`session.updated` is chatty.** It fires repeatedly while the model rewrites
the session title (`"New session - 2026-09-20T…"` → `"PONG"` within two
seconds). [verified] Compare the composed record against the last one written
and skip the write when nothing changed, or the registry file churns
continuously during a turn.

### On load: advertise nothing

**Decided 2026-09-20.** Rev 1 said to reconcile at load via
`client.v2.session.active()` and a directory-scoped list. Neither works:

- `GET /api/session/active` returns `{"data":{}}` — always, including mid-turn
  while a session is visibly busy. [verified]
- `GET /session/status` returns `{}`. [verified]
- `GET /session` and `GET /experimental/session` both return **every session
  ever created in that directory**, including long-dead ones. [verified]

And there is a real blind spot behind them: **`opencode --continue` resumes a
session and fires no events at all.** [verified] The plugin also cannot see the
`--continue` flag — it runs in a worker thread whose `argv` is just the worker
script. No route reports which session the TUI is currently showing; the whole
`/tui/*` control surface was checked.

So: **write a registry file only for sessions this process heard announced.**
Never derive one from a list.

The consequence, which is to be documented in the README rather than hidden: a
session resumed with `--continue` is not addressable until it does something —
the user types, the agent replies — at which point `session.updated` fires and
the file appears. The alternative was guessing from the session list, which
would advertise a *closed* session on every plain `opencode` start and lose
messages silently. A late peer beats a lying one.

This also makes Rev 1's "delete any file under this `instance_id` that no
longer corresponds to a live session" vacuous: the instance id is fresh each
load, so no file on disk carries it. Do the sweep in §6 instead.

**On `dispose`, remove every file carrying this `instance_id`, then unlink the
socket.** `dispose` fires reliably on both SIGTERM and SIGINT. [verified]

---

## 6. Crash and staleness

The plugin cannot guarantee cleanup, so the format survives its absence.

- **The socket is the liveness test.** A leftover socket whose process was
  `kill -9`'d refuses connections with `ConnectionRefusedError`. [verified]
  Tin Can prunes on that basis; the plugin does not need to.
- **Sweep orphans at load.** Because the instance id is random per load,
  nothing ever reclaims the files of a crashed instance, and they accumulate
  indefinitely. After the startup self-check passes, scan
  `~/.tincan/peers/opencode/`, attempt a connection to each `inst-*.sock`, and
  delete the socket plus every registry file naming that `instance_id` when
  the connection is refused. Skip any socket that accepts — that is a live
  sibling instance. This is a change from Rev 1, which left the files forever.
- **Never leave a half-written registry file.** Atomic rename, always.
- **Do not advertise what is not addressable.** See §5.

---

## 7. Wire format

Tin Can connects to the instance socket, writes **one JSON object on one
line**, and closes. No auth line — the socket is owner-only. No response is
written; delivery is acknowledged by the connection being accepted and the
line parsing.

```json
{"to_session":"ses_f4185535affe0nxzk66nw19ihJ","message_from":"billing-api","text":"<enveloped text>","delivery":"queue","message_id":"msg_01J8…"}
```

| Field | Required | Notes |
|---|---|---|
| `to_session` | yes | Must match `^ses`. Unknown id → drop and log |
| `message_from` | yes | Sender's Tin Can name, for logging only |
| `text` | yes | **Already enveloped by Tin Can. Pass through verbatim.** Must contain `<peer_message`; unenveloped → drop and log |
| `delivery` | yes | `"queue"` or `"steer"` |
| `message_id` | yes | **Must match `^msg_`.** Becomes opencode's message id |

Then:

```ts
const res = await transport.post({
  url: `/api/session/${msg.to_session}/prompt`,
  body: {
    prompt: { text: msg.text },
    delivery: msg.delivery,
    id: msg.message_id,
  },
})
```

A success is 200 whose JSON body **wraps** the admission in a `data` key:

```json
{ "data": { "admittedSeq": 16, "id": "msg_…", "sessionID": "ses_…",
            "prompt": { "text": "…" }, "delivery": "queue",
            "timeCreated": 1789902122634 } }
```

The inner object is `SessionInputAdmitted`. The wrapper is not decoration —
the server's own OpenAPI declares the 200 schema as
`{ data: SessionInputAdmitted }`, `required: ["data"]`, and a live probe
returned exactly that. Since the transport client surfaces the whole body as
its `.data`, the admission is reached at `res.data.data.admittedSeq`. Reading
one level too shallow silently classifies every success as a failure.

### Five things to get exactly right

**Always pass `delivery` explicitly.** The schema makes it optional, so
omitting it inherits opencode's default of `"steer"` while Tin Can's policy is
queue-by-default. Never omit the field — that would silently invert the policy.

`steer` promotes into the *running* turn at the next step boundary, merging
with the agent's in-flight reasoning. `queue` waits for the current
continuation loop to drain and starts a fresh turn. Tin Can sends `steer` only
when the sender set `urgent`.

**Never unwrap or reformat `text`.** It arrives carrying Tin Can's
`<peer_message>` envelope. opencode, like Codex, applies no provenance framing
of its own — a prompt injected this way is indistinguishable from the operator
typing it. **The envelope is the only thing marking it as a peer's words, which
makes it the load-bearing safety control on this path.** Do not trim it,
summarise it, or make it conditional.

This was checked end to end, not just at the call site: the injected message
appears in the session transcript as a `user` message whose `text` is
byte-identical to what went in, and the agent acted on its instruction.
[verified]

**But require it.** Not trimming the envelope is not the same as knowing it
was there: byte-identity is verified end to end while *presence* never was, so
a Tin Can regression that stopped enveloping would inject text
indistinguishable from the operator's own and nothing on this path would
notice. `parseLine` therefore rejects a `text` that does not contain the
opening token `<peer_message`, with reason `missing envelope`. The token only
— not the full tag shape — because the attributes (`from`, `runtime`, `id`)
are Tin Can's to change. This is a presence check and nothing more: the
plugin still never reads, trims, summarises or conditions on the envelope's
contents, which remain Tin Can's responsibility. Requiring the control is not
the same as conditioning on it, and this section forbids only the second.

**`message_id` must match `^msg_`.** The server enforces it and returns a clean
400 `InvalidRequestError` — *"Expected a string starting with \"msg_\""* —
otherwise. [verified] Tin Can's ids already have the prefix; assert it at the
plugin boundary anyway and drop with a log, rather than making a doomed call.

**Idempotency is a 200 replay, not a 409.** Re-submitting an identical
`message_id` returns **200** with the *same* `admittedSeq` and `timeCreated` —
the existing row, exactly as Rev 1 predicted, but without the conflict status.
[verified] A 409 `ConflictError` is reserved for a *mismatched* re-submit under
the same id, which Tin Can should never produce. Keep the 409 handling — treat
it as "already delivered", log it, do not retry, do not error — but do not
treat a 200 as proof of a fresh delivery.

**Handle the documented errors distinctly.** An unknown session returns a clean
404 `SessionNotFoundError`, not a silent drop. [verified] 400, 401, 404 and 409
are all declared. Log the `_tag` and drop; never retry.

---

## 8. Behaviour that is not optional

1. **Never crash the host.** Every socket handler, every file write, every
   transport call is wrapped. A malformed line is logged and dropped. An
   unknown `to_session` is logged and dropped. **A failure in this plugin must
   never take down or wedge the user's opencode session** — that is a far worse
   outcome than a missed message.

2. **Never log message text.** The plugin logs sender, session, delivery mode
   and message id. The body is the user's work; Tin Can's own log records it,
   and this plugin should not duplicate it into opencode's logs.

3. **Socket is `0600`, parent directory `0700`.** Owner only, and see §4 —
   this needs an explicit `chmod`. Do not widen it, do not add a TCP listener,
   do not accept connections from anywhere but the local filesystem.

4. **Read-only toward opencode's config and state.** The plugin writes only
   under `~/.tincan/peers/opencode/`. It never touches
   `~/.local/share/opencode/`, `opencode.db`, or any opencode config file.

5. **No outbound path.** This plugin only *receives*. An opencode session
   sending a message to a peer is Tin Can's MCP tool, configured separately in
   opencode's `mcp` config. Do not add a send path here — that would put
   spawn-adjacent capability in a component the user installs by copying a file.

6. **Rate limiting is Tin Can's job, not the plugin's.** Do not implement a
   second guard. If a flood arrives the plugin injects it and Tin Can is at
   fault.

---

## 9. Testing

Do not test against a real model. Stub the transport.

- **Fake socket client.** Write lines to the instance socket from a test
  process and assert the resulting call: correct URL including the `/api/`
  prefix, `delivery` passed explicitly, `id` set, `text` byte-identical.
- **Envelope integrity.** A message with a `<peer_message>` block arrives at
  the transport unmodified. Assert on bytes, not a substring.
- **HTML-not-JSON.** A stubbed 200 returning `<!doctype html>` must be treated
  as a failure, not a delivery. This is the regression test for the `/api/`
  prefix being dropped.
- **Malformed input.** Truncated JSON, missing fields, `to_session` not
  matching `^ses`, `message_id` not matching `^msg_`, unknown session,
  oversize line — each logged and dropped, plugin still alive and accepting.
- **Idempotency.** The same `message_id` twice produces one injection; a 200
  replay is not double-counted, and a 409 is swallowed and logged, not raised.
- **Registry lifecycle.** Session created → file appears. Busy → state flips.
  Deleted → file removed. `dispose` → this instance's files and socket gone.
  A no-op `session.updated` writes nothing.
- **Startup self-check.** A failing `GET /api/session` means no socket bound
  and no files written.
- **Orphan sweep.** A leftover socket with a dead pid plus its registry files;
  plugin starts, connection is refused, all of it is deleted, and a live
  sibling's files are left alone.
- **Socket permissions.** After bind, mode is `0600` and the parent is `0700`.
- **Long path.** A `TINCAN_HOME` that pushes the socket past ~100 bytes fails
  with a clear logged error, not a raw throw.

---

## 10. Done means

With the plugin installed and a plain `opencode` TUI running with no flags:

1. A registry file appears for the session within a second of its creation.
2. Writing a line to the instance socket from an unrelated shell causes the
   text to appear in that session's context and the agent to act on it.
3. `state` flips to `busy` while the agent works and back to `idle` after.
4. Quitting the TUI — by `q`, by ctrl-C, or by `SIGTERM` — removes the
   registry file and the socket.
5. Killing the TUI with `-9` leaves files behind whose socket refuses
   connections, and the next start of any instance sweeps them.
6. `opencode --continue` produces no registry file until the session is next
   active, and then produces a correct one. This is the accepted behaviour from
   §5, not a bug — assert it so nobody "fixes" it into a guess.

---

## 11. Out of scope

Do not build: an outbound send path; an HTTP fallback for when opencode does
have a port; support for `opencode serve` topologies as a distinct mode; rate
limiting; message logging; cross-machine anything; `/tui/append-prompt`
integration.

That last one is tempting and deliberately excluded. Putting text in the
human's composer is a different product decision — it interrupts a person
rather than an agent — and it belongs in a later conversation about operator
notification, not in the peer-messaging path.

---

## 12. Open questions — flag, don't decide silently

Rev 1's three questions are answered; these remain.

- **Slug uniqueness is still unproven.** Ten observed sessions gave ten
  distinct `adjective-noun` slugs, but nothing in the schema or docs declares a
  guarantee. Treat a collision as possible and key every durable record on
  `session_id`.
- **Should `retry` be distinguishable from `busy`?** It collapses to `busy` in
  v1 per §5, but `retry` means a session is stuck re-attempting a provider,
  which an operator might want to see. Raise it at the Tin Can end before
  adding a fourth `state`.
- **`_client` is private and may move.** The startup self-check turns a future
  breakage into a clean "no opencode peers" rather than a crash, but a version
  bump is the thing most likely to break this plugin. Consider asking upstream
  for the v2 client on `PluginInput`, and pin the tested version in the README.
- **No route reports the TUI's current session.** This is the root cause of the
  §5 blind spot. Worth an upstream issue; if such a route appears, §5's "on
  load, advertise nothing" can be revisited.

---

## Appendix A — what was verified, and how

Probed on 2026-09-20 against opencode 1.18.31 on macOS 25.6.0, driving a real
TUI in a pseudo-terminal with a local model, and reading the server's own
OpenAPI document from `GET /doc`.

| Rev 1 said | Reality |
|---|---|
| No TCP port | **Confirmed.** External curl refused; no LISTEN socket |
| Nominal URL is `http://opencode.internal` | Wrong — it is `http://localhost:4096/`, the SDK's default `baseUrl` |
| `.ts` loads with no build step | **Confirmed.** Bun 1.3.14, plugin runs in the TUI worker thread |
| `event` hook fires for session lifecycle | **Confirmed** for created / updated / deleted / idle / status |
| Plugin can bind a Unix socket | **Confirmed** — but at `0755`, not `0600` |
| `Bun.listen` or `node:net` | Both work in the worker; `node:net` chosen, since it is testable under vitest |
| — | `tool.execute.before` fires for MCP tools with the calling `sessionID`; tool id is `<server key>_<tool name>` |
| Single-file deliverable | Impossible — the loader calls every exported function as a plugin; helpers must live in an unglobbed `tincan-lib/` |
| `client.v2.session.prompt()` | Does not exist. No `client.v2` at runtime |
| — | v2 API is reachable at `POST /api/session/{id}/prompt` via `client._client` |
| Idempotent re-submit raises 409 | Returns **200** with the same `admittedSeq`; 409 is for a mismatched re-submit |
| `dispose` fires on exit | **Confirmed** on SIGTERM and SIGINT; not on SIGKILL |
| Reconcile at load via `active()` | `active()` returns `{}` always; list routes return dead sessions |
| Session ids are not UUIDs | **Confirmed.** `ses_` + 12 hex of descending timestamp + ~14 base62 |

**Suffix derivation (Rev 1 §12, first question) — the existing rule
transfers unmodified.** `CANONICAL_ID.md`'s rule (strip everything outside
`[0-9a-f]`, take the **last three**, lowercase) produced eight distinct
suffixes from eight real session ids. Because it takes the last three, the
characters come from the random tail rather than the shared timestamp prefix —
the same property the rule was designed for against Codex's UUIDv7. Two notes
for the Tin Can end, neither requiring a change:

- Filtering base62 down to hex skews the alphabet: `a`–`f` are drawn from both
  letter cases while digits come from one, so collision odds sit somewhat above
  a uniform 1/4096.
- The fixed hex prefix guarantees at least three hex characters, so an opencode
  id can never hit the empty-suffix known defect.

Worked example: `ses_f4185535affe0nxzk66nw19ihJ` → hex-filtered
`ef4185535affe06619` → suffix `619`.
