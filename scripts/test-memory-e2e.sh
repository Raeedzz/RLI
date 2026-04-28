#!/usr/bin/env bash
# End-to-end smoke test for the RLI memory daemon.
#
# Assumes RLI is already running (so the daemon is bound). Hits the live
# HTTP routes via curl and asserts:
#   1. /health returns ok
#   2. POST /memory/add stores a fact
#   3. GET  /memory/search recalls it
#   4. POST /memory/add again with similar content dedupes/merges
#
# Exit 0 on success, non-zero on failure. Safe to run repeatedly —
# uses a "smoke-$RANDOM" project_id so it doesn't collide with real
# project data.

set -euo pipefail

PROJECT="smoke-$RANDOM"
SESSION="smoke-session"

# Resolve daemon URL — same precedence as the rli-memory wrapper.
url() {
    if [ -n "${RLI_MEMORY_URL:-}" ]; then
        echo "$RLI_MEMORY_URL"
        return
    fi
    local pf="$HOME/Library/Application Support/RLI/memory-port"
    if [ -r "$pf" ]; then
        echo "http://127.0.0.1:$(tr -d '[:space:]' < "$pf")"
        return
    fi
    echo "http://127.0.0.1:5555"
}

URL=$(url)
echo "→ daemon at $URL"

# 1. health
curl -fsS "$URL/health" | grep -q '"ok":true' || {
    echo "✗ /health did not return ok=true" >&2
    exit 1
}
echo "✓ /health"

# 2. add
add_resp=$(curl -fsS -X POST -H "Content-Type: application/json" \
    -d "{\"content\":\"we use bun for builds\",\"kind\":\"fact\",\"project_id\":\"$PROJECT\",\"session_id\":\"$SESSION\"}" \
    "$URL/memory/add")
echo "$add_resp" | grep -q '"id"' || { echo "✗ add: no id in response: $add_resp" >&2; exit 1; }
echo "$add_resp" | grep -q '"merged":false' || { echo "✗ add: expected merged=false on first insert" >&2; exit 1; }
echo "✓ /memory/add (first insert)"

# 3. search
search_resp=$(curl -fsS -G \
    --data-urlencode "q=bun" \
    --data-urlencode "project_id=$PROJECT" \
    "$URL/memory/search")
echo "$search_resp" | grep -q "we use bun for builds" || {
    echo "✗ search did not return the stored fact: $search_resp" >&2
    exit 1
}
echo "✓ /memory/search"

# 4. dedupe — same content paraphrased, expect merged=true
dedup_resp=$(curl -fsS -X POST -H "Content-Type: application/json" \
    -d "{\"content\":\"we use bun, not npm, for our builds\",\"kind\":\"fact\",\"project_id\":\"$PROJECT\",\"session_id\":\"$SESSION\"}" \
    "$URL/memory/add")
echo "$dedup_resp" | grep -q '"merged":true' || {
    echo "✗ dedupe: expected merged=true, got: $dedup_resp" >&2
    exit 1
}
echo "✓ /memory/add (dedupe path)"

echo
echo "all checks passed (project=$PROJECT)"
