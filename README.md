# CountyRoot

Merkle fingerprints of U.S. county parcel extracts on Solana.

**Not a deed. Not title. Not a token.**

| | |
|---|---|
| Program | CountyRoot |
| Packets | [countyroot.com](https://countyroot.com) |
| Product (intel / passports) | [vara.land](https://vara.land) |
| Contact | [hello@countyroot.com](mailto:hello@countyroot.com) |

One `CountyRoot` PDA per county (FIPS) per epoch holds a 32-byte merkle root. The lot list lives off-chain as `lots.csv`. No owner names are hashed or stored.

## Status

Private repo while the program is built. Solana Fall School Demo Day — 16 October 2026. Maintainer: JG21OX.

## License

MIT. Public extracts remain the counties’. This repo is the fingerprint software, not the official roll.
