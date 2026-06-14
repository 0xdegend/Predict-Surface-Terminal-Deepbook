#!/usr/bin/env bash
#
# setup-published-deps.sh — make `sui client publish` work for skew_fee.
#
# WHY: the `predict-testnet-4-16` branch of MystenLabs/deepbookv3 ships a
# `Published.toml` for the `deepbook` package but NOT for `deepbook_predict` or
# `token`. Without those, Sui's publish step treats them as "unpublished
# dependencies" and refuses to publish (or, worse, would publish useless copies).
#
# This script writes the missing `Published.toml` files (testnet) into the git
# dependency cache (~/.move), pinning each to its real deployed testnet address
# read from the live `deepbook_predict` package's linkage table. Idempotent —
# safe to re-run. Run once before `sui client publish`.
#
# If MystenLabs later commit these Published.toml files (or register the package
# in MVR), this script becomes a no-op and can be deleted.
set -euo pipefail

write_published() {
  # $1 = package SUBDIR under packages/ (note: deepbook_predict lives in packages/predict)
  local subdir="$1" published_at="$2" original_id="$3"
  local toml
  toml=$(find "$HOME/.move/git" -path "*deepbookv3*/packages/$subdir/Move.toml" 2>/dev/null | head -1 || true)
  if [[ -z "$toml" ]]; then
    echo "  ! packages/$subdir not found in ~/.move cache — run \`sui move build\` first to fetch deps, then re-run."
    return 1
  fi
  local dir; dir=$(dirname "$toml")
  cat > "$dir/Published.toml" <<EOF
# Written by setup-published-deps.sh — the upstream branch shipped no Published.toml.
[published.testnet]
chain-id = "4c78adac"
published-at = "$published_at"
original-id = "$original_id"
version = 1
EOF
  echo "  ✓ packages/$subdir → $dir/Published.toml"
}

echo "Pinning testnet published addresses for skew_fee dependencies:"
# deepbook_predict's source subdir is packages/predict
write_published predict \
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138" \
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
write_published token \
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8" \
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8"
echo "Done. (deepbook already ships its own Published.toml.) You can now publish."
