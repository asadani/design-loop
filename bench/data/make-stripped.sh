#!/bin/sh
# Build a stripped, history-free copy of a pinned commit. The agent under test works on this copy only.
# Usage: ./make-stripped.sh gopass|swagger-php
set -eu
cd "$(dirname "$0")"
name="$1"
case "$name" in
  gopass)
    commit=f03c0d2f
    strip="ARCHITECTURE.md AGENTS.md docs/adr docs/components.png docs/components.dot" ;;
  swagger-php)
    commit=fd3b62e4
    # The whole docs tree plus agent/context files describe the pipeline; none can stay.
    strip="docs AGENTS.md CLAUDE.md CONTEXT.md ROADMAP.md" ;;
  *) echo "unknown repo $name" >&2; exit 2 ;;
esac
out="stripped/$name"
rm -rf "$out"; mkdir -p "$out"
# Export the pinned tree with a throwaway index. NOT `git archive`: it honours export-ignore and silently drops
# tests/, tools/ and dotfiles. checkout-index writes every tracked file and never writes .git (no history).
idx="$(mktemp -u)"
GIT_INDEX_FILE="$idx" git -C "sources/$name" read-tree "$commit"
GIT_INDEX_FILE="$idx" git -C "sources/$name" checkout-index -a --prefix="$(pwd)/$out/"
rm -f "$idx"
: > "$out/../$name.stripped.log"
for p in $strip; do
  if [ -e "$out/$p" ]; then rm -rf "$out/$p"; echo "removed $p" >> "$out/../$name.stripped.log"; else echo "MISSING $p" >> "$out/../$name.stripped.log"; fi
done
echo "$name @ $commit -> $out"; cat "$out/../$name.stripped.log"
