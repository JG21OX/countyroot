// Verify one parcel against its county's root on Solana Devnet. No wallet, no account.
//   node examples/verify-parcel.mjs [County.ST] [parcel-id]
import { verifyParcel, readCountyRoot, getCounty } from "@countyroot/sdk/web";

const [county = "Travis.TX", parcelId = "186831703"] = process.argv.slice(2);

const res = await verifyParcel(county, parcelId);
console.log(`${res.county.label} epoch ${res.county.epoch}, parcel ${parcelId}: ${res.verified ? "VERIFIED" : "NOT VERIFIED"}`);
for (const r of res.rows) console.log(`  ${r.parcel_id}  acres ${r.acres}  lot_sqft ${r.lot_sqft}  leaf ${r.leaf}  ${r.ok ? "ok" : r.reason}`);
console.log(`  root source: ${res.anchor.kind}${res.anchor.slot ? ` (slot ${res.anchor.slot})` : ""}${res.anchor.note ? ` - ${res.anchor.note}` : ""}`);

// Read the county PDA directly.
const c = await getCounty(county);
try {
  const acct = await readCountyRoot(c.pda);
  console.log(`  PDA ${c.pda}: status ${acct?.status} (1 = active), ${acct?.nParcels} parcels, root ${acct?.merkleRoot}`);
} catch (e) {
  console.log(`  PDA ${c.pda}: RPC unreachable (${e.message}); try another RPC with { rpc: "https://..." }`);
}
process.exitCode = res.verified ? 0 : 1;
