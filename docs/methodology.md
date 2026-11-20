# Airport Disruption Index — methodology v1.0.0

The Airport Disruption Index (ADI) counts **airport-minutes under an active FAA ground stop (GS) or
ground delay program (GDP)** across a fixed panel of 20 US hub airports, per UTC day. It is built to
be cited as a settlement source: every number can be recomputed by anyone from archived, hashed
source data.

The machine-readable parameters, with their hash, are served at `GET /api/v1/methodology`. They are
generated from `src/lib/index/methodology.ts`, the same constant the calculation code reads.

## What is published

| Series                 | Definition                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| **ADI** (headline)     | Airport-minutes with an active GS **or** GDP at a panel airport.             |
| **ADI-GS** (sub-index) | Airport-minutes with an active GS at a panel airport. GDPs are not counted.  |
| Per-airport breakdown  | Both series for each of the 20 airports.                                     |
| Hourly running value   | Both series per UTC hour, for today (`/api/v1/current`) and in every print.  |
| Daily settlement print | The immutable, hashed value for a UTC day, published after the cutoff below. |

The range of each daily value is 0 to 28,800 (20 airports × 1,440 minutes).

## The panel

The top 20 of the [FAA Core 30](https://aspm.faa.gov/aspmhelp/index/Core_30.html) airports ranked by
FAA calendar-year 2024 commercial-service enplanements
([FAA CY2024 enplanements](https://www.faa.gov/airports/planning_capacity/passenger_allcargo_stats/passenger/arp-cy2024-commercial-service-enplanements.pdf)),
in rank order:

`ATL DFW DEN ORD LAX JFK CLT LAS MCO MIA PHX SEA SFO EWR IAH BOS MSP FLL LGA DTW`

Why this panel: the Core 30 is the FAA's own list of airports with significant activity, so the
panel is not our selection; enplanements are a published, auditable ranking; 20 airports keeps the
index focused on the hubs whose disruptions propagate through the system. Codes are FAA 3-letter
identifiers, which is what the source feed uses. The panel is fixed for v1. Changing it is a
methodology release and a level break (see Versioning).

## Source

One source: the FAA NAS Status airport feed,
`https://nasstatus.faa.gov/api/airport-status-information` (XML). See [sources.md](sources.md).

- A **ground stop** is an entry in a `Ground_Stop_List` (`Program` elements; `Ground_Stop` is
  accepted as the same thing).
- A **ground delay program** is an entry in a `Ground_Delay_List` (`Ground_Delay` elements).
- An airport is identified by the entry's `ARPT`, matched exactly against the panel codes.
- `Delay_type` blocks are classified by the list element they contain, not by `Name`, because the
  same `Name` can repeat and older payloads omit it. Every block is read.
- Arrival/departure delays, airspace flow programs and airport closures are parsed and recorded in
  the receipt as `ignored`; they never count. Any other list is recorded as `unrecognized`; it never
  fails the round and never counts.
- A GS or GDP list holding an element we do not know fails the round (`parse_error`). Skipping it
  could silently drop an active program, which is worse than a visible gap.

The index is **sample-based**. The feed carries no start times, and its GS `End_Time` is
airport-local text with no date. Neither is used: a program counts only in slots where a valid
observation shows it, and nothing is inferred from `End_Time`, `Avg` or `Max`. Those fields are kept
verbatim in the receipt for reference.

## Rounds and slots

- The day is the **UTC** day, divided into **288 five-minute slots**.
- A **round** is one poll of the feed. It belongs to slot `floor(fetchedAt, 5 min)`, where
  `fetchedAt` is when the whole response body arrived. Its id is the slot start at minute precision,
  e.g. `2026-11-17T20:45Z`.
- A collector runs every 5 minutes (Vercel Cron). It can be run again safely.

### Valid observation

A round is **valid** when all of these hold; otherwise it is **invalid** with one reason:

| Check                                                                                                                             | Reason if it fails    |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A response arrived (15 s timeout)                                                                                                 | `network_error`       |
| HTTP status is 200                                                                                                                | `http_status`         |
| The body is UTF-8, well-formed XML with root `AIRPORT_STATUS_INFORMATION`, a parseable `Update_Time` and well-formed GS/GDP lists | `parse_error`         |
| `Update_Time` is at most **900 s** before `fetchedAt`                                                                             | `stale_feed`          |
| `Update_Time` is at most **120 s** after `fetchedAt`                                                                              | `feed_ahead_of_clock` |

The last check is a v1 refinement: a feed time well ahead of our clock means one of the two clocks
is wrong, and slot assignment depends on ours. The feed updates about once a minute, so 120 s allows
ordinary skew. An invalid round counts as **not received**.

**Quorum is 1, by design.** This is a single-source index. There is no second source to vote
against, so a round stands or falls on its own checks. The undocumented `/api/airport-events` JSON
is noted in [sources.md](sources.md) as a possible future cross-check; it is not used in v1.

### One round per slot

The **earliest-fetched valid round** in a slot is the slot's observation. Later rounds in the same
slot are duplicates and are dropped. An invalid round stands only until a valid round arrives in the
same slot; the valid one replaces it. Once a slot has ended, its receipt never changes.

## Airport-minutes

In each slot, each panel airport whose state shows an active GS or GDP contributes **5
airport-minutes** to the headline, **at most once per slot**: an airport with both a GS and a GDP,
or with the program listed twice, still contributes 5. The GS-only sub-index counts the same way
with GS only.

## Carry/suspend ladder

Each slot has one status:

| Status     | Meaning                                                                       | Contributes                      | Coverage |
| ---------- | ----------------------------------------------------------------------------- | -------------------------------- | -------- |
| `observed` | The slot has a valid round.                                                   | That round's state               | Yes      |
| `carried`  | No valid round, and the last observed slot is 1 or 2 slots earlier (≤10 min). | The last observed state, flagged | No       |
| `missing`  | No valid round and nothing to carry.                                          | 0                                | No       |
| `pending`  | The slot has not ended and has no valid round yet (running value only).       | 0                                | No       |

Carrying never extends past 2 slots, never guesses, and never extrapolates. An all-clear state
carries the same way as an active one.

**The ladder restarts each UTC day** (refinement): slot 0 never carries from the previous day's
slot 287. A day's print therefore depends only on that day's receipts, which makes it independently
reproducible from one day of data.

## Coverage and day status

Coverage = valid rounds / 288. Carried slots do not count. Status is compared in integers
(`valid × 100 ≥ threshold × 288`), so float rounding cannot move a boundary:

| Status      | Coverage        | Valid rounds | Print                                    |
| ----------- | --------------- | ------------ | ---------------------------------------- |
| `final`     | ≥ 95%           | ≥ 274        | Value published                          |
| `degraded`  | ≥ 80% and < 95% | 231–273      | Value published, flagged degraded        |
| `suspended` | < 80%           | ≤ 230        | **No settlement value**, only the reason |

`coverage.percent` in responses is rounded to 2 decimals for display. Status comes from the integer
count.

## Settlement

- Day D settles at **D+1 00:30Z**. A daily cron builds the print then; it can be run again safely
  and never overwrites a print.
- The print is built only from day D's stored receipts. Each one is checked against its own
  `receiptHash` first. Rounds cannot be added after day D ends, because a round's slot is set by its
  fetch time.
- A **print** (`GET /api/v1/days/{date}`) contains: date, revision, correction (null on revision 1),
  methodology version, parameter hash, `settlesAt`, coverage, the result (status, value, GS-only
  value, per-airport minutes and hourly series, or for a suspended day only a reason), every round's
  id, status and `receiptHash`, and `printHash`.
- `printHash` = sha256 of the canonical JSON of the print without `printHash`.

### Revisions

None after settlement, except a **correction print**: revision 2 or later, naming the `printHash` it
supersedes and a stated reason. The original stays published (`revisions` in the day response lists
every revision; `print` is the latest). Corrections exist for operational faults such as a
misconfigured deployment. They are never used to apply a later methodology to past days.

## Receipts

Every round, valid or not, is stored as a receipt (`GET /api/v1/rounds/{id}`) with its raw response
body (`GET /api/v1/rounds/{id}/raw`, the bytes exactly as received):

`roundId`, `slotStart`, `fetchedAt`, `sourceUrl`, `httpStatus`, `rawSha256` (sha256 of the body
bytes), `rawBytes`, `methodologyVersion`, `parameterHash`, and `observation`. A valid observation
holds `feedUpdateTime`, the parsed GS/GDP events, the ignored and unrecognized `Delay_type` lists,
and per-panel-airport state. An invalid one holds the reason, a detail and `feedUpdateTime` when it
could be read. Last is `receiptHash`, the sha256 of the canonical JSON of the receipt without
`receiptHash`.

## Hashing

Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no whitespace, numbers in
JavaScript's shortest round-trip form, non-finite numbers rejected. Hashes are lowercase hex sha256.

The **parameter hash** is the sha256 of the canonical JSON of the methodology parameters. For v1.0.0
it is:

`e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363`

It is pinned in `src/lib/index/methodology.test.ts`, so a parameter change cannot ship under an
existing version.

## Reproducing

```sh
npm run reproduce -- 2026-11-17T20:45Z            # one round
npm run reproduce -- 2026-11-17                   # a settled day: every round, then the print
npm run reproduce -- <id> --base-url https://airports.apexsofteng.com
```

For a round, the script fetches the receipt and raw body from the public API, checks `rawSha256` and
`receiptHash`, re-parses the body, rebuilds the receipt with the same calculation code and compares
every field. For a day, it does that for every round the print lists, then rebuilds the print and
compares. It prints `MATCH` or `MISMATCH` with the differing fields. Exit codes: 0 match, 1
mismatch, 2 could not verify (unreachable, not found, or published under a different methodology
version; check out the commit that released that version).

## Versioning

Any change to a parameter, to the panel, or to how events become airport-minutes is a new
methodology version with a new parameter hash. A change that can move the value without any change
in disruption (for example a different panel) is a **level break**. History is never rescaled or
chain-linked, and a print always carries the version it was computed under.

## Out of scope for v1

- Backfill before the first production round: see "History / backfill" in [sources.md](sources.md).
- Ground stop end times, delay magnitudes (`Avg`/`Max`), closures, arrival/departure delays and
  airspace flow programs.
