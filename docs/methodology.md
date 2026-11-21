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
  same `Name` can repeat across blocks and older payloads omit it on uncounted blocks. Every block
  is read. A block holding a GS or GDP list must carry exactly one `Name`, `Ground Stop Programs` or
  `Ground Delay Programs` respectively; otherwise the round fails (`parse_error`). The XML
  declaration and processing instructions are ignored.
- Arrival/departure delays, airspace flow programs and airport closures are parsed and recorded in
  the receipt as `ignored`; they never count. Any other list is recorded as `unrecognized`; it never
  fails the round and never counts.
- A GS or GDP list holding an element we do not know fails the round (`parse_error`). Skipping it
  could silently drop an active program, which is worse than a visible gap. So does a document
  without exactly one `AIRPORT_STATUS_INFORMATION` root, or a GS/GDP list anywhere other than
  directly inside a `Delay_type` block.

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

The archive keeps one receipt per slot. **The first valid round written wins**: once a valid receipt
is stored for a slot it is never replaced, and any later round in that slot is a duplicate and is
dropped. An invalid receipt stands only until a valid round is written in the same slot, which
replaces it. Precedence is the order of writes to the archive, not fetch times.

**Admission deadline.** Before any storage I/O, the collector checks that it is earlier than **60
seconds after the end** of the round's slot; a round that fails this check is not stored. The check
is on admission, so an admitted write can finish later: the collect function runs for at most 60 s,
so the last admitted write of day D (slot 23:55Z, admitted until D+1 00:01Z) is done by about
00:02Z, at least 28 minutes before the 00:30Z settlement cutoff. Every receipt a print reads is
therefore final. The API serves a valid receipt and its raw body with immutable cache headers,
because a valid receipt is never replaced, and an invalid one (or the 404 for its missing body) with
`no-store`.

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

| Status      | Coverage        | Valid rounds | Print                                     |
| ----------- | --------------- | ------------ | ----------------------------------------- |
| `final`     | ≥ 95%           | ≥ 274        | Value published, settlement-eligible      |
| `degraded`  | ≥ 80% and < 95% | 231–273      | Value published, flagged, does not settle |
| `suspended` | < 80%           | ≤ 230        | **No settlement value**, only the reason  |

`coverage.percent` in responses is rounded to 2 decimals for display. Status comes from the integer
count.

## Settlement

- Day D settles at **D+1 00:30Z** (the cutoff), and its print is published by **D+1 01:30Z** (the
  publication deadline). A cron builds the print at 00:30Z and runs again at 00:45Z and 01:00Z; a
  run after the print exists changes nothing, and no run ever overwrites a print. See
  [Settlement rules](#settlement-rules).
- The print is built only from day D's stored receipts, each checked against its own `receiptHash`
  first. The day index that serves the running value is a cache of those receipts: each collect
  reconciles it against a listing of the day's receipts, and settlement rebuilds it. Settlement
  never reads it. No round can be added after the last slot's admission deadline (D+1 00:01Z),
  because a round's slot is set by its fetch time.
- A **print** (`GET /api/v1/days/{date}`) contains: date, revision, correction (null on revision 1),
  methodology version, parameter hash, `settlesAt`, coverage, the result (status, value, GS-only
  value, per-airport minutes and hourly series, or for a suspended day only a reason), every round's
  id, status and `receiptHash`, and `printHash`.
- `printHash` = sha256 of the canonical JSON of the print without `printHash`.

### Revisions

None after settlement, except a **correction print**: revision 2 or later, naming the `printHash` it
supersedes and a stated reason. The original stays published (`revisions` in the day response lists
every revision; `print` is the latest). Corrections exist for operational faults such as a
misconfigured deployment. They are never used to apply a later methodology to past days. Who may
issue one, and until when, is under [Settlement rules](#settlement-rules).

## Settlement rules

These rules decide what a contract that cites the index settles on. Where a rule and the rest of
this document disagree, the rule wins and the disagreement is a documentation bug.

1. **Only `final` prints are settlement-eligible.** A `degraded` print and a `suspended` print are
   published, hashed and archived like any other, but neither is a settlement value. A `degraded`
   value is shown for information only.
2. **The print is revision 1 of `GET /api/v1/days/{date}`**, unless a correction replaces it under
   rule 8. Nothing else (the running value, `/api/v1/history`, the site) is a settlement value.
3. **Missing data only ever lowers the value.** A slot with no valid round contributes 0 after at
   most 2 carried slots. A `final` day can lack up to 14 valid rounds and still settle, so a `final`
   value can be lower than the disruption that happened, never higher. Nothing is estimated or
   backfilled to compensate.
4. **One methodology per day.** A new methodology version takes effect only at 00:00Z of a UTC day,
   announced in advance on the incident log (`/incidents`). Every round records the version and
   parameter hash it was collected under. If any of a day's rounds carries a version or parameter
   hash other than the one the print is computed under, the day prints `suspended` with the reason
   `mixed methodology` and the rounds found under each version; it never prints a value mixed from
   two methodologies. A round under another methodology is not counted in the running value either,
   and `/api/v1/current` lists such rounds in `foreignMethodologies`.
5. **The feed moving or changing shape suspends rather than guesses.** Redirects are not followed: a
   moved feed makes rounds invalid (`network_error` or `http_status`). A changed GS or GDP list
   fails the round (`parse_error`). Either way the day loses coverage and falls to `degraded` or
   `suspended`, so it does not settle; the index never reads a value from a source or shape v1 does
   not know. The operator announces such a change on the incident log. Following the feed to a new
   address or shape is a methodology release under rule 4 and never applies to past days.
6. **New list types are recorded and flagged, never counted.** A `Delay_type` list v1 does not know
   is recorded in the receipt as `unrecognized`. Any unrecognized list seen in today's valid rounds
   is listed in `unrecognizedLists` in `/api/v1/current` and on [/status](/status), so a feed change
   that could hide a program is visible the same day. If the FAA starts reporting ground stops or
   ground delay programs in a new list, v1 undercounts until a new methodology version counts it.
7. **Publication deadline and retries.** The print for day D is due by **D+1 01:30Z**. The settle
   job runs at 00:30Z and retries at 00:45Z and 01:00Z; each run reads every receipt of the day and
   checks it against its `receiptHash`, and one that cannot be read or verified stops that run
   without printing anything. If no print exists at the deadline the operator opens an incident on
   the incident log. **A late print is still the print**: it is built by the same rules from the
   same receipts, and lateness alone never changes its status or value.
8. **Corrections.** Only Apex Software Engineering LLC, the operator, issues a correction print
   (revision 2 or later, see [Revisions](#revisions)). A correction may be published only within
   **24 hours after the original print was published**; after that the print stands. Each correction
   is announced on the incident log (`/incidents`) with the superseded `printHash` and the reason,
   and both revisions stay published.

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

With Node 24, clone the public source first:

```sh
git clone https://github.com/apex-software-engineering/airport-disruption-index && cd airport-disruption-index && npm ci
```

Then, from the checkout:

```sh
ROUND_ID=2026-11-20T04:30Z
npm run reproduce -- "$ROUND_ID" --base-url https://airports.apexsofteng.com
npm run reproduce -- 2026-11-20 --base-url https://airports.apexsofteng.com
```

The first command reproduces one round. The second reproduces a settled day (2026-11-20 settled
`degraded` at 2026-11-21T00:30Z): every round, then the print. A day that has not settled yet
exits 2. Any round ID or settled date from the API works in place of these.

For a round, the script fetches the receipt and raw body from the public API, checks `rawSha256` and
`receiptHash`, re-parses the body, rebuilds the receipt with the same calculation code and compares
every field. For a day, it does that for every round the print lists, then rebuilds the print and
compares. It prints `MATCH` or `MISMATCH` with the differing fields. Exit codes: 0 match, 1
mismatch, 2 could not verify (unreachable, not found, or published under a different methodology
version; check out the commit that released that version).

## Versioning

Any change to a parameter, to the panel, or to how events become airport-minutes is a new
methodology version with a new parameter hash. A version takes effect at a UTC day boundary only
(see [Settlement rules](#settlement-rules), rule 4). A change that can move the value without any
change in disruption (for example a different panel) is a **level break**. History is never rescaled
or chain-linked, and a print always carries the version it was computed under.

## Out of scope for v1

- Backfill before the first production round: see "History / backfill" in [sources.md](sources.md).
- Ground stop end times, delay magnitudes (`Avg`/`Max`), closures, arrival/departure delays and
  airspace flow programs.
