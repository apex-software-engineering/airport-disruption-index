# Feed fixtures

Recorded and synthetic payloads of the FAA NAS Status airport feed
(`https://nasstatus.faa.gov/api/airport-status-information`), used by the parser and round tests.

| File                                    | Provenance                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-2026-11-17T20-43-56Z.xml`         | Real. Fetched from the live feed at 2026-11-17 20:43:56 UTC. No GS or GDP was active.                                                                                                                          |
| `live-2026-11-17T20-58-29Z.xml`         | Real. Fetched from the live feed at 2026-11-17 20:58:29 UTC. No GS or GDP was active.                                                                                                                          |
| `live-2026-11-20T01-03-33Z.xml`         | Real. Archived by the preview collector, round `2026-11-20T01:00Z` (sha256 `7da1d45a…`). Ground delay programs at SFO, SAN and LAS.                                                                            |
| `synthetic-gs-gdp.xml`                  | Synthetic, written for this repo. Shape copied from the live feed; the LGA ground stop and SFO ground delay program values mirror ones observed on the live feed on 2026-11-16.                                |
| `synthetic-edge-cases.xml`              | Synthetic, written for this repo. Repeated `Delay_type` names, the `Ground_Stop` child variant, an empty list, an uncounted block without `Name`, an ignored list, an unknown `Delay_type` and an empty block. |
| `synthetic-processing-instructions.xml` | Synthetic. An XML declaration, a stylesheet processing instruction and a PI inside a GS list; must parse normally.                                                                                             |
| `synthetic-gs-block-without-name.xml`   | Synthetic. A GS list in a block with no `Name`; must be rejected.                                                                                                                                              |
| `synthetic-gdp-block-two-names.xml`     | Synthetic. A GDP list in a block with two `Name` elements; must be rejected.                                                                                                                                   |

Live payloads are a US Government work (17 U.S.C. 105). No live ground stop has been recorded yet;
add one when the collector archives one (every round's raw body is served at
`/api/v1/rounds/{id}/raw`).
