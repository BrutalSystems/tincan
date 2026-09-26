# The message log

What Tin Can records, how damage is reported, and what happens at
rotation.

## Log

`~/.tincan/messages.jsonl`, append-only, one logical record per message:

```json
{"id":"msg_...","at":"2026-09-19T11:58:44.955Z","direction":"out",
 "from":{"runtime":"codex","name":"tincan","cwd":"/src/tincan"},
 "to":{"runtime":"claude-code","name":"billing-api","cwd":"/src/billing",
       "session_id":"5af69d42-2214-41d9-b13f-9c3177eb60ce"},
 "text":"...","method":"inbox","delivered":false,"expect_reply":true,"delivery":"queue"}
{"id":"msg_...","at":"...","kind":"outcome","delivered":true}
```

The message is written *before* delivery is attempted, so a crash mid-send still
leaves a record. The outcome is a separate append; `message_log` folds it onto
the message so you read one record per message.

The written `delivered` field is **not** what you read back. It is false at
write time for every message and only means anything once an outcome is folded
onto it, so `message_log` drops it and returns `outcome` instead: `accepted`,
`failed`, or `indeterminate` — written out, with nothing ever observed about
what happened next, which is what a crash mid-send leaves behind. Do not read
`indeterminate` as either success or failure.

`delivery` is `"queue"` or `"steer"` — the *effective* mode, not bare `urgent`
intent. It reads `"steer"` only when `urgent` was set on a peer whose runtime
can act on it (opencode today); an urgent send to Codex or Claude Code still
logs `"queue"`, because that is what actually happened to the peer's turn.
Records written before this field existed simply lack it — do not read its
absence as `"queue"`.

### Damage is reported, not skipped

Each record carries `prev` and `hash`: a sha256 over the record, chained to the
one before it. A half-written line, a corrupted file or an edit in an editor
used to be skipped silently, so the log simply reported fewer messages than
happened and nothing said so. Now `message_log` returns an `integrity` field
when the chain does not hold:

```json
{"records":[…],
 "integrity":{"ok":false,"unparseable":1,"tampered":0,"broken":0,"interleaved":0,
              "unchained":0,
              "detail":"Log integrity: 1 line(s) could not be parsed …"}}
```

The field is **absent when the log is healthy**, so its presence is the signal.
Records are still returned either way — a damaged log must not become an empty
one.

**Interleaving is not damage, and is counted apart from it.** The log is
machine-global: every live session's Tin Can appends to it, so a writer can
chain onto a head that was current when it read it and stale by the time it
wrote. The result is a record whose `prev` names an earlier record that is
still right there in the file. Nothing is missing.

`broken` therefore means what it says — a record names a predecessor that **is
not in this log** — while `interleaved` counts the harmless case, and does not
make `ok` false. Measured on a ten-session machine before the split: 79 of 79
chain breaks were interleaving and none were damage, while the report called
all 79 damage and told the reader the log "was edited" with `tampered` reading
0 in the same object. A chain that cries wolf gets ignored, which costs exactly
the detection it was built for.

### History survives a rotation, and stays reachable

The live log rotates once it passes 5 MiB. The **whole** file moves into
`messages.archive.jsonl` and a new one starts with a checkpoint record, because
keeping a tail would mean reading the live file and writing part of it back —
and on a machine-global log with one writer per session, an append landing
between that read and the rename is destroyed. Losing a message is not a price
worth paying to keep recent history in one file.

`message_log` reads across the seam. When a query cannot be satisfied from the
live file alone, the archive's tail is read too, so a rotation does not make
yesterday's conversation invisible. Two things stay true by design:

- **The archive is never hashed.** Rotation exists to bound the read, and the
  archive only grows. Archived records come back unverified; the live file is
  still verified eagerly and in full.
- **The archive read is capped.** If the cap bites, `rotated.complete` is
  `false` — meaning a record missing from your result may simply be further
  back, and "not found" is not "never sent".

**What this is and is not.** The chain lives in the same file as the data, so
anything that can rewrite the log can recompute it. This is integrity against
truncation, corruption and careless edits — not security against a deliberate
same-user adversary, who can already replace the `tincan` binary. Verifiable
provenance is a separate job and needs signing, not hashing.

Records written before chaining existed are counted as `unchained` and are not
a fault: the format is append-only and that history is real. A log that
predates this reads back clean, and the chain simply starts at the next record
appended.
