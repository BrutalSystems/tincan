# Mail routing: messages to the chief of staff go to its mailbox

On a machine that runs a **chief of staff** — one Claude Code session that holds
the seat in `~/.local/state/my-handler/seat` and talks with the human — Tin Can
does not deliver direct messages into that session. It files them in the chief
of staff's mailbox, [`cos-mail`](https://github.com/BrutalSystems/claude-fleet),
which the chief of staff reads when it is ready. Without this, every worker's
DONE report or refusal cut into the human's conversation as a new turn.

Decided 2026-10-17 (#26, option 1: "all senders into the mailbox, three
exceptions"). Machines with no seat file are not affected at all.

## What happens

A message (`send_peer` or `tincan send`) whose recipient is the seated session:

- is filed with `cos-mail send <sender's session id> <KIND> "<text>" --from <sender>
  --session-id <id> --reply-to <sender's canonical id> --key tincan:<message id>`;
- is **not** delivered into the session;
- returns `outcome: accepted`, `method: cos-mail`, and a `notice` naming the mail
  number.

`KIND` is the first word of the text when it is one of `STARTED STATUS BLOCKED
DECISION DONE STOPPED` ("DONE: PR merged" files as DONE); otherwise `STATUS`.
`REQUEST` and `ALERT` are never inferred. cos-mail keeps one line per item, so
newlines in the text become spaces. A `tincan send --reply-via` is appended to the
text, since an external sender has no canonical id to reply to.

The seat is read on every send, so routing follows the seat across restarts and
handoffs. It is matched by the session id in the seat's canonical id, not by name.

## Exceptions — delivered as before

1. Text starting `SCOTTY-` or `HANDOFF-` (leading spaces ignored): the handoff
   protocol, which is time-critical.
2. A reply (`in_reply_to`) to a message the chief of staff sent with
   `expect_reply: true`: it asked, and is waiting on the answer.
3. `tincan send --from cos-mail`: cos-mail's own urgent ping. Mailing it would
   mean urgent mail never reaches the session.

An **urgent** message (`urgent: true`) is filed as urgent mail; cos-mail then
pings the seat with its one line, "mail: N urgent — cos-mail read", which comes
through exception 3. cos-mail exits 0 even when that ping fails, so Tin Can
reads its output: no `pinged <name>` line means the message is delivered
directly as well.

Nobody seated, an unreadable seat file, or routing off: delivered as before.

## When cos-mail cannot file it

Tin Can **calls** cos-mail rather than writing `mail.jsonl` itself: cos-mail
appends under an `fcntl` lock Node cannot take, and also keeps the activity feed
and ledger. If the call fails — cos-mail not on `PATH`, a refusal (text over its
8000-character limit), a timeout (10 s) — it is tried once more under the same
`--key`, so a first try that filed the item and then stalled answers "already
sent" instead of filing it twice. If that fails too, the message is delivered
directly, and the result's `notice` says why. Routing never loses a message.

`tincan send` prints the `notice` on stderr; the JSON line on stdout keeps its
four fields. A CLI sender is external — it has no session id or canonical id —
so its mail carries its `--from` name and, if given, `--reply-via` in the text.

## Turning it off

Either of:

- `touch ~/.tincan/mail-routing-off` (under `$TINCAN_HOME` if set). Read on every
  send, so it takes effect at once in every running session; delete the file to
  turn routing back on.
- `TINCAN_MAIL_ROUTING=off` in the Tin Can process's environment (also `0`,
  `false`, `no`). Needs that process restarted.

## Environment

- `XDG_STATE_HOME` — where the seat file is: `$XDG_STATE_HOME/my-handler/seat`.
  Default `~/.local/state`, the same rule cos-mail uses.
- `TINCAN_COS_MAIL` — the cos-mail to call. Default `cos-mail` on `PATH`.
- `TINCAN_MAIL_ROUTING`, `TINCAN_HOME` — the off switches above.

Code: `src/mail-routing.ts`; the hook is in `send_peer` (`src/tools.ts`).
