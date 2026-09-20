#!/usr/bin/env python3
"""Send one Tin Can wire line to an opencode instance socket.

Usage:
  send.py <socket> <session-id>
    Generates a unique message_id (msg_smoke<epoch-millis>) and sends the
    default test envelope asking for reply "GOLDFISH".

  send.py <socket> <session-id> --id <message-id>
    Uses the provided message_id instead of generating one.

  send.py <socket> <session-id> --text <custom-text>
    Sends custom text body (and generates a unique message_id). The text must
    contain a <peer_message ...> envelope; the plugin drops anything else with
    reason "missing envelope".

  send.py <socket> <session-id> --id <message-id> --text <custom-text>
    Both explicit id and custom text.

Each injection must have a unique message_id; opencode treats a re-submitted id
with different content as a 409 ConflictError (mismatched re-submit), not a
delivery retry.
"""
import json
import socket
import sys
import time

if len(sys.argv) < 3:
    print(__doc__, file=sys.stderr)
    sys.exit(1)

sock_path, session = sys.argv[1], sys.argv[2]

# Parse optional flags
message_id = None
text = None
i = 3
while i < len(sys.argv):
    if sys.argv[i] == "--id":
        if i + 1 >= len(sys.argv):
            print("error: --id requires an argument", file=sys.stderr)
            sys.exit(1)
        message_id = sys.argv[i + 1]
        i += 2
    elif sys.argv[i] == "--text":
        if i + 1 >= len(sys.argv):
            print("error: --text requires an argument", file=sys.stderr)
            sys.exit(1)
        text = sys.argv[i + 1]
        i += 2
    else:
        print(f"error: unknown argument {sys.argv[i]}", file=sys.stderr)
        sys.exit(1)

# Generate message_id if not provided
if message_id is None:
    message_id = f"msg_smoke{int(time.time() * 1000)}"

# Use default envelope if no custom text provided
if text is None:
    text = (
        f'<peer_message from="acceptance" id="{message_id}">\n'
        'Reply with exactly the word GOLDFISH and nothing else.\n'
        '</peer_message>'
    )

payload = json.dumps({
    "to_session": session,
    "message_from": "acceptance",
    "text": text,
    "delivery": "queue",
    "message_id": message_id,
})

try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(sock_path)
    s.sendall((payload + "\n").encode())
    s.close()
    print(f"sent {message_id} -> {session}")
except FileNotFoundError:
    print(f"error: socket not found: {sock_path}", file=sys.stderr)
    sys.exit(1)
except ConnectionRefusedError:
    print(f"error: connection refused: {sock_path} (instance is gone)", file=sys.stderr)
    sys.exit(1)
except OSError:
    print(f"error: cannot connect to socket: {sock_path}", file=sys.stderr)
    sys.exit(1)
except Exception as e:  # noqa: BLE001 - a smoke tool reports anything it hits
    print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
