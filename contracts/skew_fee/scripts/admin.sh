#!/usr/bin/env bash
#
# admin.sh — retune the Skew builder fee / treasury (founder-only).
#
# Requires the active `sui client` address to hold the AdminCap minted at publish.
# Set these once (from the publish output), then run a subcommand:
#
#   export SKEW_FEE_PKG=0x...        # the published skew_fee package id
#   export SKEW_FEE_CONFIG=0x...     # the shared FeeConfig object id
#   export SKEW_FEE_ADMINCAP=0x...   # the AdminCap object id (in your wallet)
#
#   ./admin.sh fee 150               # set fee to 1.50% (150 bps, max 200)
#   ./admin.sh treasury 0xYOURTREASURY
#   ./admin.sh show                  # print current fee_bps + treasury
#
set -euo pipefail

: "${SKEW_FEE_PKG:?set SKEW_FEE_PKG}"
: "${SKEW_FEE_CONFIG:?set SKEW_FEE_CONFIG}"

cmd="${1:-show}"

case "$cmd" in
  fee)
    : "${SKEW_FEE_ADMINCAP:?set SKEW_FEE_ADMINCAP}"
    bps="${2:?usage: ./admin.sh fee <bps>}"
    sui client call --package "$SKEW_FEE_PKG" --module fee_router --function set_fee_bps \
      --args "$SKEW_FEE_ADMINCAP" "$SKEW_FEE_CONFIG" "$bps"
    ;;
  treasury)
    : "${SKEW_FEE_ADMINCAP:?set SKEW_FEE_ADMINCAP}"
    addr="${2:?usage: ./admin.sh treasury <address>}"
    sui client call --package "$SKEW_FEE_PKG" --module fee_router --function set_treasury \
      --args "$SKEW_FEE_ADMINCAP" "$SKEW_FEE_CONFIG" "$addr"
    ;;
  show)
    echo "Reading FeeConfig $SKEW_FEE_CONFIG …"
    sui client object "$SKEW_FEE_CONFIG" --json | python3 -c \
      'import sys,json; f=json.load(sys.stdin)["content"]["fields"]; print("fee_bps:", f["fee_bps"], "(=%.2f%%)" % (int(f["fee_bps"])/100)); print("treasury:", f["treasury"])'
    ;;
  *)
    echo "usage: ./admin.sh {fee <bps>|treasury <address>|show}" >&2
    exit 1
    ;;
esac
