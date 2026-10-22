# @countyroot/sdk

Verify U.S. county parcel records against their on-chain fingerprints on Solana.
[CountyRoot](https://countyroot.com) posts one Merkle root per county: **212 counties, 53 million+ parcels**, live on
Solana Devnet. This SDK checks a parcel against that root. No wallet, no account.

The foundation of land tokenization on Solana.

Program: `7mi96nPvP6SB1eApAd7vN2uUEBDvNR9xVvLqPDt3uvwg` (Devnet) · Not a deed. Not a title. Not a token.
Try it in the browser first: [countyroot.com/verify](https://countyroot.com/verify/).

## Install

```sh
npm install @countyroot/sdk
```

Node 18+ (the `/web` entry needs Node 19+, or any modern browser, Deno or Bun).

## Quickstart: verify a parcel

```js
import { verifyParcel } from "@countyroot/sdk/web";

// Fetches the parcel's proof from packets.countyroot.com,
// reads the county's PDA on Solana Devnet, and recomputes the root.
const res = await verifyParcel("Travis.TX", "186831703");

console.log(res.verified ? "VERIFIED" : "NOT VERIFIED");
for (const row of res.rows) console.log(row.parcel_id, row.acres, row.lot_sqft, row.leaf);
console.log("root from", res.anchor.kind, "slot", res.anchor.slot);
```

`verified` is `true` only when the parcel is in the county's packet, its proof leads to the root, and that root was
read from an **active** CountyRoot account on-chain. If the RPC can't be reached, `anchor.kind` is `"published"` and
`verified` stays `false`. Pass `{ rpc: "https://your-devnet-rpc" }` to use your own RPC (the public Devnet RPC rate-limits).

Runnable version: `node examples/verify-parcel.mjs Travis.TX 186831703` (exit code 0 means verified).

The same code runs the [countyroot.com/verify](https://countyroot.com/verify/) page. In a page without a bundler:

```html
<script type="module">
  import { verifyParcel } from "https://cdn.jsdelivr.net/npm/@countyroot/sdk/dist/browser/countyroot-web.min.js";
  console.log((await verifyParcel("Travis.TX", "186831703")).verified);
</script>
```

## Read a county PDA

Each county epoch has its own PDA (program-derived address), seeded by `"county_root"`, FIPS and epoch (u32 LE).
It holds the Merkle root, parcel count, schema, status (1 = active, 2 = retracted) and post time.

```js
// Browser-friendly, no dependencies:
import { getCounty, readCountyRoot, listCounties } from "@countyroot/sdk/web";
const county = await getCounty("Travis.TX");          // { fips: 48453, epoch, pda, merkle_root, n_parcels, ... }
const acct = await readCountyRoot(county.pda);         // decoded account, owner checked
console.log((await listCounties()).length);            // 212

// Node, with @solana/web3.js:
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { countyRootPda, fetchCountyRoot } from "@countyroot/sdk";
const pda = countyRootPda(48453, 3);                   // derive it yourself
const root = await fetchCountyRoot(new Connection(clusterApiUrl("devnet")), 48453, 3);
```

## Entry points

| Import | What | Runs in |
|---|---|---|
| `@countyroot/sdk` | Leaf/tree rules (v1, v2), PDAs, account and event decoding, RPC helpers, CLI | Node (ESM and CJS) |
| `@countyroot/sdk/web` | `verifyParcel`, `getCounty`, `listCounties`, `readCountyRoot` (fetch + WebCrypto, zero dependencies) | Browsers, Node 19+, Deno, Bun |
| `@countyroot/sdk/browser` | `/web` as one minified ES module (for CDNs) | Browsers |
| `@countyroot/sdk/idl.json` | Anchor IDL of the CountyRoot program | anywhere |

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

`npm test` (builds, then runs offline tests). Set `COUNTYROOT_PACKET=/path/X.csv` (with `X.root.json` beside it) to
also check a real packet end to end.

## Links

- Verify a parcel in your browser: [countyroot.com/verify](https://countyroot.com/verify/)
- Website: [countyroot.com](https://countyroot.com) · X: [@CountyRootSol](https://x.com/CountyRootSol)
- Source: [github.com/JG21OX/countyroot](https://github.com/JG21OX/countyroot) (`countyroot/sdk`)

## License

[PolyForm Shield 1.0.0](LICENSE), the same license as the rest of the CountyRoot repo. Required Notice: Copyright (c) 2026 CountyRoot (https://countyroot.com).
