# Mail routing: messages to a configured recipient go to a mailbox

Some setups have one session that should not be interrupted by every message
addressed to it — for example a session in conversation with a person, where
each Tin Can message would otherwise arrive as a new turn in that conversation.
Mail routing lets you name that session (the **recipient**) and an **inbox
command**. Tin Can then files direct messages to the recipient with the inbox
command instead of delivering them, and the recipient reads its mailbox when it
is ready.

It is off unless configured: with no recipient file, nothing changes.

## Configuration

`$TINCAN_HOME/mail-routing.json` (default `~/.tincan/mail-routing.json`; or the
path in `$TINCAN_MAIL_ROUTING_CONFIG`). Every key is optional:

```json
{
  "recipientFile": "~/.tincan/mail-recipient",
  "command": "tincan-mailbox",
  "commandSender": "tincan-mailbox",
  "deliverPrefixes": []
}
```

| Key | Meaning | Default |
|---|---|---|
| `recipientFile` | File naming the recipient: `<name> <canonical id>`, anything after ignored. A leading `~/` is your home directory. | `$TINCAN_HOME/mail-recipient` |
| `command` | The inbox command: a name on `PATH` or a path. | `tincan-mailbox` |
| `commandSender` | The `tincan send --from` name the inbox command notifies under; always delivered. | the command's base name |
| `deliverPrefixes` | Text starting with one of these is delivered, not filed. | none |

The configuration and the recipient file are read on every send, so routing
follows the recipient across restarts and handoffs. The recipient is matched by
the session id in its canonical id, not by name. A missing or malformed
configuration file means the defaults.

## What happens

A message (`send_peer` or `tincan send`) addressed to the recipient:

- is filed with `<command> send <sender's session id> <KIND> "<text>" --from <sender>
  --session-id <id> --reply-to <sender's canonical id> --key tincan:<message id>`,
  plus `--urgent` for an urgent message;
- is **not** delivered into the session;
- returns `outcome: accepted`, `method: mailbox`, and a `notice` naming the
  inbox command and, when the command printed `mail #<n>`, the mail number.

`KIND` is the first word of the text when it is one of `STARTED STATUS BLOCKED
DECISION DONE STOPPED` ("DONE: PR merged" files as DONE); otherwise `STATUS`.
`REQUEST` and `ALERT` are never inferred. A `tincan send --reply-via` is
appended to the text, since an external sender has no canonical id to reply to.

## Exceptions — delivered as before

1. Text starting with one of `deliverPrefixes` (leading spaces ignored): for a
   time-critical protocol the recipient answers itself.
2. A reply (`in_reply_to`) to a message the recipient sent with
   `expect_reply: true`: it asked, and is waiting on the answer.
3. `tincan send --from <commandSender>`: the inbox command's own notification.
   Mailing it would mean urgent mail never reaches the session.

An **urgent** message (`urgent: true`) is filed with `--urgent`; the inbox
command is expected to notify the recipient (through exception 3) and print a
line starting `notified ` (or `pinged `) when it did. Without that line the
message is delivered directly as well: urgent mail nobody is told about is not
urgent.

No recipient file, an unreadable one, or routing off: delivered as before.

## When the inbox command cannot file it

Tin Can **calls** the inbox command rather than writing any mailbox itself: the
command owns its storage and locking. If the call fails — no such command, a
non-zero exit, a timeout (10 s) — it is tried once more under the same `--key`,
so a first try that filed the item and then stalled can answer "already sent"
instead of filing it twice. If that fails too, the message is delivered
directly, and the result's `notice` says why. Routing never loses a message.

`tincan send` prints the `notice` on stderr; the JSON line on stdout keeps its
four fields. A CLI sender is external — it has no session id or canonical id —
so its mail carries its `--from` name and, if given, `--reply-via` in the text.

## Turning it off

Any of:

- delete the recipient file;
- `touch ~/.tincan/mail-routing-off` (under `$TINCAN_HOME` if set). Read on every
  send, so it takes effect at once in every running session; delete the file to
  turn routing back on;
- `TINCAN_MAIL_ROUTING=off` in the Tin Can process's environment (also `0`,
  `false`, `no`). Needs that process restarted.

## Environment

- `TINCAN_HOME` — where `mail-routing.json`, the default recipient file and
  `mail-routing-off` live. Default `~/.tincan`.
- `TINCAN_MAIL_ROUTING_CONFIG` — another configuration file to read instead.
- `TINCAN_MAIL_ROUTING` — the off switch above.

Code: `src/mail-routing.ts`; the hook is in `send_peer` (`src/tools.ts`).
