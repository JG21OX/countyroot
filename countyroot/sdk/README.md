# @countyroot/sdk

TypeScript SDK and CLI for [CountyRoot](https://countyroot.com): verify that a parcel is in a county
packet whose Merkle root is posted on Solana, and read CountyRoot accounts and events safely.

Program: `7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg` · Not a deed. Not a title. Not a token.

> Not published to npm yet. Build locally: `cd countyroot/sdk && npm install && npm run build`.

## The trust rule for events (read this first)

CountyRoot events are Anchor `emit!` events: base64 `Program data:` log lines. **Any program can
print an identical line**, and Solana truncates long logs. So the SDK only accepts an event if:

1. The transaction **succeeded** (`meta.err === null`). Failed transactions are refused.
2. The `Program data:` line was printed while **CountyRoot was the innermost executing program**.
   The SDK replays the `invoke [n]` / `success` / `failed` lines as a call stack, so lines printed by
   another program, by a program that CPIs into CountyRoot, or by a CPI child of CountyRoot, are
   ignored. Inconsistent frames throw.
3. The logs are **not truncated**. A `Log truncated` line throws `TruncatedLogsError` by default
   (`onTruncated: "flag"` returns what was parsed and `truncated: true`).
4. Reads default to **`finalized`** commitment.
5. Optionally, `crossCheck: true` compares root events with the **current account state**. A later
   update/retract/close legitimately changes it; mismatches are reported, not thrown.

Accounts are the source of truth for "what is the root now"; events are the history.

## Proofs

- Leaf: `sha256(utf8(parcel_id + "|" + acres(6dp) + "|" + lot_sqft(2dp)))`, rounding half-up.
- Tree: leaves in packet (CSV) order, parent `sha256(left || right)` (no sorting), and an odd level
  duplicates its last node. This matches the packets and every `root.json`.
- A proof is `{ leaf, index, siblings[], leafCount }`, plus `parcel_id/acres/lot_sqft` from the CLI.
  `verifyProof` also checks the proof length against `leafCount` and the odd-node rule.

## Accounts

`decodeConfig`, `decodeCountyRoot`, `decodePendingAuthority`. `CountyRoot.version` is `0` for legacy
98-byte accounts and byte 98 for 99-byte (v1+) accounts. PDAs: `configPda()`,
`countyRootPda(fips, epoch)`, `pendingAuthorityPda()`.

## CLI

```
countyroot proof  --csv Adams.CO.1.2026-10.csv --parcel <id> --out proof.json
countyroot verify --root Adams.CO.1.2026-10.root.json --proof proof.json [--fips 8001 --epoch 1]
countyroot verify --root X.root.json --csv X.csv --parcel <id> --rpc devnet   # also checks on-chain
```

Offline, `verify` checks the leaf against the parcel fields, the leaf count against `n_parcels`,
and the proof against `root.json`. With `--rpc` it also requires the on-chain root to match, be
active (not retracted), and have the same parcel count. Exit code 0 means VERIFIED.

## Tests

`npm test`. Set `COUNTYROOT_PACKET=/path/X.csv` (with `X.root.json` beside it) to also check a
real packet end to end.

## License

[MIT](LICENSE). The SDK in this folder is MIT-licensed so anyone can build on CountyRoot data; the rest of the CountyRoot repo, including the on-chain program, stays under PolyForm Shield 1.0.0.
