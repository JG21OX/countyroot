#!/usr/bin/env bash
# Mainnet preflight: refuses a program binary that was built with the devnet feature.
# Run before any Mainnet deploy:  scripts/check-mainnet-so.sh target/deploy/countyroot.so
# Devnet builds embed COUNTYROOT_DEVNET_BUILD_v1 (lib.rs, #[cfg(feature = "devnet")]); that feature
# is what enables the one-time migration instructions and test FIPS 90000-99999.
set -euo pipefail
SO="${1:-$(dirname "$0")/../target/deploy/countyroot.so}"
[ -f "$SO" ] || { echo "REFUSE: $SO not found" >&2; exit 1; }
case "$(basename "$SO")" in *devnet*) echo "REFUSE: $SO is the Devnet variant" >&2; exit 1;; esac
if LC_ALL=C grep -aq "COUNTYROOT_DEVNET_BUILD" "$SO"; then
  echo "REFUSE: $SO was built with --features devnet (migration + test FIPS compiled in)" >&2; exit 1
fi
DEV="$(dirname "$SO")/countyroot-devnet.so"
if [ -f "$DEV" ] && cmp -s "$SO" "$DEV"; then echo "REFUSE: $SO is identical to the Devnet build" >&2; exit 1; fi
echo "OK: $SO is a Mainnet build (no devnet marker)"
