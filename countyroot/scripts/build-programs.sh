#!/usr/bin/env bash
# Builds both program variants. Mainnet = default features (migration instructions return DevnetOnly).
#   target/deploy/countyroot.so         mainnet build (deploy to Mainnet)
#   target/deploy/countyroot-devnet.so  --features devnet (deploy to Devnet; migration + test FIPS 90000-99999)
# `touch` forces a relink: build-sbf only refreshes target/deploy when it actually rebuilds,
# so without it a feature switch can silently leave the previous variant in place.
set -euo pipefail
cd "$(dirname "$0")/../programs/countyroot"
touch src/lib.rs && cargo build-sbf --arch v0 --features devnet
cp ../../target/deploy/countyroot.so ../../target/deploy/countyroot-devnet.so
touch src/lib.rs && cargo build-sbf --arch v0
(cd ../../test-programs/cpi_signer && cargo build-sbf --arch v0)
cmp -s ../../target/deploy/countyroot.so ../../target/deploy/countyroot-devnet.so && { echo "ERROR: variants identical" >&2; exit 1; }
ls -l ../../target/deploy/countyroot.so ../../target/deploy/countyroot-devnet.so
sha256sum ../../target/deploy/countyroot.so ../../target/deploy/countyroot-devnet.so 2>/dev/null || shasum -a 256 ../../target/deploy/countyroot.so ../../target/deploy/countyroot-devnet.so
