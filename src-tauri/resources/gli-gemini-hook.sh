#!/bin/bash
# GLI Hook — forwards Google Gemini CLI events to GLI via Unix socket.
# Installed and managed by GLI; safe to remove (GLI re-installs on next launch).

SOCKET_PATH="/tmp/gli-agent.sock"

# Exit silently if socket doesn't exist (GLI not running).
[ -S "$SOCKET_PATH" ] || exit 0

# Skip helper-agent invocations — see gli-claude-hook.sh for rationale.
[ -n "$GLI_HELPER_AGENT" ] && exit 0

/usr/bin/python3 -c "
import json, socket, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

out = {
    'provider': 'gemini',
    'session_id': payload.get('session_id', ''),
    'transcript_path': payload.get('transcript_path', ''),
    'cwd': payload.get('cwd', ''),
    'event': payload.get('hook_event_name', ''),
    'tool': payload.get('tool_name', ''),
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
