# CountyRoot

CountyRoot is source-available software that posts a Merkle root of a U.S. county's public parcel extract to Solana (one PDA per county per epoch), while the full parcel list stays off-chain as a downloadable CSV. It is not a deed, title, or token; it is a public, time-stamped fingerprint that a specific extract existed and that any single parcel in it can be proven against that root. The county remains the legal source; CountyRoot only fingerprints the public data so it can later serve as the foundation for people who want to tokenize their own land.

Not a deed. Not a title. Not a token. The county remains the legal source.

| | |
|---|---|
| Program | CountyRoot |
| Site | https://countyroot.com |
| Contact | hello@countyroot.com |
| X | [@CountyRootSol](https://x.com/CountyRootSol) |

One account per county (FIPS) per epoch holds a 32-byte merkle root. The parcel list stays off-chain. No owner names are hashed or stored.

## Status

Solana Fall School Demo Day — 16 October 2026.
Live on Devnet: 212 counties across 41 states. See https://countyroot.com for the full list.
Maintainer: JG21OX.

## License

Source-available and free to use under the [PolyForm Shield License 1.0.0](LICENSE). Anyone, including businesses, may use, copy, and modify this software at no cost. You may not use it to build or sell a product or service that competes with CountyRoot. The SDK in [`countyroot/sdk`](countyroot/sdk) is the exception: it is MIT-licensed, so anyone can use it to verify CountyRoot data.

Public extracts remain the counties’. This repo is the fingerprint software, not the official roll.

## Trademarks

"CountyRoot" and the CountyRoot logo are trademarks of CountyRoot. They may not be used to name, brand, or promote a modified copy or any derived product or service without written permission. Forks must use a different name and logo.

© 2026 CountyRoot
