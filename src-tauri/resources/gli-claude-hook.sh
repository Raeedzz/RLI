#!/bin/bash
# GLI Hook — forwards Claude Code events to GLI app via Unix socket.
# Installed and managed by GLI; safe to remove (GLI re-installs on next launch).

SOCKET_PATH="/tmp/gli-claude.sock"

# Exit silently if socket doesn't exist (GLI not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Forward stdin JSON to the socket. CRITICAL: we use `python3 -c "..."`
# (inline string), NOT a heredoc — a heredoc replaces python's own
# stdin with the heredoc body, leaving NO stdin for the actual hook
# payload, so `json.load(sys.stdin)` reads empty and the script no-ops.
# Notchi uses the same `-c` form; we match it.
/usr/bin/python3 -c "
import json, socket, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

# Forward a flat envelope. The 'aux' field carries the event's
# sub-classifier — today only Notification needs one (its
# notification_type field, e.g. idle_prompt / permission_prompt).
# The Rust side uses (event, aux) together to derive status.
out = {
    'provider': 'claude',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
    'tool_use_id': payload.get('tool_use_id', ''),
    'permission_mode': payload.get('permission_mode', 'default'),
    'aux': payload.get('notification_type', ''),
}

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(0.5)
    sock.connect('$SOCKET_PATH')
    sock.sendall(json.dumps(out).encode())
    sock.close()
except Exception:
    pass
"
