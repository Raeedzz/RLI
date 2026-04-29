#!/usr/bin/env bash
#
# Downloads ripgrep into src-tauri/binaries/ as a Tauri sidecar binary
# so RLI ships with `rg` baked in — no `brew install ripgrep` required.
#
# Tauri's `bundle.externalBin` mechanism expects the binary name to be
# `<name>-<rust-target-triple>` (e.g. rg-aarch64-apple-darwin). We pull
# from BurntSushi's official releases on GitHub. The script is
# idempotent — re-runs are no-ops once the binary is in place.

set -euo pipefail

VERSION="${RG_VERSION:-14.1.1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../src-tauri/binaries"
mkdir -p "$BIN_DIR"

# Map host arch + OS → ripgrep release archive name and Rust target triple.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    ARCHIVE="ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz"
    TARGET="aarch64-apple-darwin"
    ;;
  Darwin-x86_64)
    ARCHIVE="ripgrep-${VERSION}-x86_64-apple-darwin.tar.gz"
    TARGET="x86_64-apple-darwin"
    ;;
  Linux-x86_64)
    ARCHIVE="ripgrep-${VERSION}-x86_64-unknown-linux-musl.tar.gz"
    TARGET="x86_64-unknown-linux-gnu"
    ;;
  Linux-aarch64)
    ARCHIVE="ripgrep-${VERSION}-aarch64-unknown-linux-gnu.tar.gz"
    TARGET="aarch64-unknown-linux-gnu"
    ;;
  *)
    echo "[download-rg] unsupported host: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

DEST="$BIN_DIR/rg-$TARGET"
if [[ -x "$DEST" ]]; then
  echo "[download-rg] already present → $DEST"
  exit 0
fi

URL="https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${ARCHIVE}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[download-rg] fetching $URL"
curl -fsSL "$URL" -o "$TMP/rg.tar.gz"
tar -xzf "$TMP/rg.tar.gz" -C "$TMP"

# The archive extracts into a directory named after the archive — find
# the inner `rg` binary regardless of the version baked into the path.
INNER="$(find "$TMP" -name rg -type f -perm -u+x | head -n 1)"
if [[ -z "$INNER" ]]; then
  echo "[download-rg] couldn't find rg binary inside $ARCHIVE" >&2
  exit 1
fi

cp "$INNER" "$DEST"
chmod +x "$DEST"
echo "[download-rg] installed → $DEST"
