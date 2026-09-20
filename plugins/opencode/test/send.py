#!/usr/bin/env python3
"""Send one Tin Can wire line to an opencode instance socket.

Usage: send.py <socket> <session-id> [message-id] [text]

If message-id is omitted, a unique one is generated. Each injection must have a
unique message_id; opencode treats a re-submitted id with different content as a
409 ConflictError (mismatched re-submit), not a delivery retry.
"""
import json
import socket
import sys
import time

if len(sys.argv) < 3:
    print(__doc__, file=sys.stderr)
    sys.exit(1)

sock_path, session = sys.argv[1], sys.argv[2]

# Generate or use provided message_id
if len(sys.argv) > 3 and not sys.argv[3].startswith('<'):
    message_id = sys.argv[3]
    text_arg_idx = 4
else:
    # Generate unique id: msg_smoke<epoch-millis>
    message_id = f"msg_smoke{int(time.time() * 1000)}"
    text_arg_idx = 3

# Use provided text or default envelope
if len(sys.argv) > text_arg_idx:
    text = sys.argv[text_arg_idx]
else:
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

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.sendall((payload + "\n").encode())
s.close()
print(f"sent {message_id} -> {session}")
