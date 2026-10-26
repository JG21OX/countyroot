# countyroot-verify

Check a CountyRoot parcel proof inside your own Solana program. The crate reads the
CountyRoot root account (and the county's head account), recomputes the Merkle root from
the parcel row and its proof, and checks that the root is current. It makes no CPI and
needs no CountyRoot program at runtime beyond the accounts you pass in.

**Status:** 0.1.0, **Devnet only**. The `mainnet` feature is a compile error until the
mainnet program exists; its ID will differ.

```toml
[dependencies]
countyroot-verify = { version = "0.1", features = ["devnet"] }
```

Exactly one cluster feature must be on. Building with none is a compile error, so you
can't ship a build that points at the wrong program by accident.

## Usage

```rust,ignore
use countyroot_verify::{verify_parcel, Freshness, ParcelRow, Proof};

// accounts: [county_root, county_head, ...]
let row = ParcelRow { id: b"0123456789", occ: 1, acres_micro: 250_000, sqft_centi: 0 };
let proof = Proof { index, siblings: &siblings }; // siblings: &[[u8; 32]]
let root = verify_parcel(&accounts[0], Some(&accounts[1]), fips, &row, &proof, Freshness::LatestActive)
    .map_err(|e| ProgramError::Custom(e.code()))?;
// root.epoch, root.n_parcels, root.data_as_of, root.fetched_at, root.source_sha256, ...
```

Proofs come from the CountyRoot SDK (`ProofV2` JSON: `index`, `siblings`, `row`). The
addresses are `county_root_address(fips, epoch)` and `county_head_address(fips)`.

`test-programs/parcel_gate` in the repository is a complete example program: it verifies
a parcel and writes a receipt PDA. It is tested in LiteSVM only and is not deployed.

## What gets checked

1. **Account.** Owner is the CountyRoot program. Size is 256 bytes, discriminator and
   layout version 2 match, and the address re-derives from `["county_root", fips, epoch]`
   with the stored bump. The head is checked the same way (`["county_head", fips]`, 48 bytes).
   Legacy 98/99-byte roots and v1 leaves are refused (`BadLayout` / `WrongSchema`).
2. **Proof.** The leaf is
   `sha256(0x00 ‖ "countyroot/leaf/v2" ‖ fips ‖ u16 id_len ‖ id ‖ occ ‖ acres_micro ‖ sqft_centi)`
   (integers little-endian); nodes are `sha256(0x01 ‖ left ‖ right)`, with an odd last
   node promoted unchanged; the root is
   `sha256(0x02 ‖ "countyroot/root/v2" ‖ fips ‖ epoch ‖ u64 n ‖ top)`. The number of
   siblings must be exactly what `(index, n)` implies, and `index < n`.
3. **Freshness policy.**

| Policy | Accepts |
|---|---|
| `LatestActive` (default) | Only the county's current root: status ACTIVE and `head.latest_active_epoch == epoch`. Needs the head account. |
| `ActiveOrSuperseded` | Any root that was not retracted. Use for historical facts ("was in the 2026-10 roll"). |
| `Exact(epoch)` | Only that epoch, unless retracted. |

A retracted root is refused under every policy.

## Trust model

The crate proves that a row is in the packet CountyRoot posted. It does not prove the
county's data is right. CountyRoot's attestor key posts roots; the crate trusts that key
through the program's ownership of the accounts. `RootView` exposes the provenance
hashes (manifest, source download, packet), `data_as_of`, `fetched_at` and the flags
(`migrated()`, `fetched_at_is_upper_bound()`), so you can apply your own age limit.
Absence proofs ("this parcel is not in the roll") are not supported.

## Errors

`VerifyError::code()` is `0x4352_0000 + n` ("CR"), ready for `ProgramError::Custom`.

| n | Error | n | Error |
|---|---|---|---|
| 1 | WrongOwner | 9 | EpochMismatch |
| 2 | WrongPda | 10 | IndexOutOfRange |
| 3 | BadLayout | 11 | BadProofLength |
| 4 | WrongSchema | 12 | RootMismatch |
| 5 | Retracted | 13 | BadId |
| 6 | Superseded | 14 | HeadRequired |
| 7 | NoActiveRoot | 15 | BadStatus |
| 8 | FipsMismatch | | |

## Cost (LiteSVM, measured)

| Case | Verify CU | Tx size |
|---|---|---|
| Real Los Angeles proof, 22 siblings | about 8,200 | 986 bytes |
| Real Travis proof, 19 siblings | about 7,600 | 889 bytes |
| Real Osage proof, 16 siblings | about 7,100 | 798 bytes |
| Worst fitting case: 256-byte id, 22 siblings | about 10,300 | 1,232 bytes (the limit) |

CU is the verify instruction minus a no-op baseline. Each sibling adds 32 bytes, so a
256-byte id with more than 22 siblings does not fit in one legacy transaction; typical ids
(under 30 bytes) leave room for about 28 siblings.

## Test vectors

`tests/fixtures/vectors.json` is produced by the TypeScript reference (`sdk/src/leafv2.ts`),
and `real-proofs.json` holds proofs from the posted Travis TX, Osage OK and Los Angeles CA
packets. `devnet-accounts.json` is a read-only snapshot of the matching Devnet accounts.
To regenerate (Node 20+, built SDK):

```sh
CR_SDK_DIST=../../sdk/dist/src node tools/gen-vectors.mjs [path/to/v2-packets]
cargo test --features devnet
```

## License

PolyForm Shield 1.0.0 (see `LICENSE`). You can use this crate in your own programs, including
commercial ones, as long as you are not offering a product that competes with CountyRoot.
It is not MIT or Apache licensed.
