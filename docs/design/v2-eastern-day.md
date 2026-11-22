# Design: methodology v2.0.0, the US Eastern day

Status: **draft for review, revision 2** (phase 1, no code). Refs #11. Round 1 review dispositions
are listed at the end.

Methodology v2.0.0 changes one thing: the day a settlement print covers. v1 counts the UTC day. v2
counts the civil day in **America/New_York** (US Eastern, "ET"). The slot grid, the source, the
panel, the observation checks, the carry ladder and the coverage percentages are unchanged. Every v1
print, receipt and attestation keeps settling, reproducing and verifying under v1, byte for byte,
forever.

Decisions this review should settle are marked **D1** to **D7** and collected at the end.

## 0. Why ET (primary sources)

The owner's rule was to keep UTC only if comparable indexes and Kalshi use it. Each claim below
cites the primary document and quotes the line it rests on. Anything not opened is marked
**unverified** and is not relied on.

Two different things are at stake, and the sources treat them separately:

- the **observation day**: which hours of activity a value counts. This is what v2 changes.
- **trading and expiry times**: when a contract stops trading or reads its source. These are
  contract terms. The index does not set them.

| Source                                                                                                                                                                                                                                                                                                                                                                                 | Verbatim                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Observation day                                                                                                                  | Trading / expiry                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Kalshi AIRPORTDELAY certification, [AIRPORTDELAY.pdf](https://assets.kalshi.com/regulatory/product-certifications/AIRPORTDELAY.pdf)                                                                                                                                                                                                                                                    | "All times relating to <time period> and to the scheduling and operation of flights are interpreted in the local time of <airport> unless otherwise specified. The end of <time period> is defined as 11:59:59 PM local time at <airport> on the final day of the specified period." / "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET."                                                                                                          | Airport-local day                                                                                                                | 10:00 AM ET                                   |
| Kalshi FLIGHTJFK certification, [FLIGHTJFK.pdf](https://assets.kalshi.com/regulatory/product-certifications/FLIGHTJFK.pdf)                                                                                                                                                                                                                                                             | "The Last Trading Time will be 11:59 PM ET." / "Expiration Date: The Expiration Date of the Contract shall be the sooner of the date of the first 10:00 AM ET following the release of the data for all of <date>, or one week after <date>." / "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET."                                                                                                                                                 | `<date>`, zone not stated (JFK is in ET, so "local" and "ET" coincide)                                                           | Last trade 11:59 PM ET; expiry 10:00 AM ET    |
| Kalshi ORDDLY certification, [ORDDLY.pdf](https://assets.kalshi.com/regulatory/product-certifications/ORDDLY.pdf)                                                                                                                                                                                                                                                                      | "Date: <date> refers to a calendar <date> specified by Kalshi." / "Expiration time: The Expiration time of the initial Contract iteration shall be 10:00 AM ET."                                                                                                                                                                                                                                                                                                             | Not stated                                                                                                                       | 10:00 AM ET, for a Central-time airport       |
| Kalshi temperature certification (the PM's source for KXHIGH), [GLOBALTEMPERATURE.pdf](https://assets.kalshi.com/regulatory/product-certifications/GLOBALTEMPERATURE.pdf)                                                                                                                                                                                                              | "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET." / "The Last Trading Time will be one minute prior to the final time in <time period>."                                                                                                                                                                                                                                                                                                          | **Unspecified** in the document. It does not name KXHIGH, so the mapping to KXHIGH is **unverified**                             | 10:00 AM ET                                   |
| Kalshi API, KXFLYCANCJFK markets, [markets?series_ticker=KXFLYCANCJFK](https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXFLYCANCJFK) (read 2026-11-21)                                                                                                                                                                                                             | `rules_primary`: "…that are cancelled during October 21, 2026 is at least 50%, then the market resolves to Yes." / `rules_secondary`: "All dates and times relating to the scheduling and operation of flights are interpreted in the local time of John F. Kennedy International Airport (JFK/KJFK) unless otherwise specified." / "Schedule baseline: The schedule baseline for this market is October 19, 2026 at 11:59:59 PM ET." / `close_time`: `2026-10-22T14:00:00Z` | Airport-local day                                                                                                                | Closes 14:00Z = 10:00 AM EDT the next morning |
| BTS Technical Directive #17, [bts.gov](https://www.bts.gov/topics/airlines-and-airports/number-17-technical-directive-time-reporting-effective-oct-1-2008) (live page 403 to us; read via [Wayback snapshot 2026-07-21](http://web.archive.org/web/20260721200224/https://www.bts.gov/topics/airlines-and-airports/number-17-technical-directive-time-reporting-effective-oct-1-2008)) | "All scheduled and actual arrival and departure times will be reported in local time using a 24 hour clock" / "In using local time, the reporting carrier must adjust for time zone differences in computing data elements O, P, and S."                                                                                                                                                                                                                                     | US on-time statistics use airport-local times                                                                                    | n/a                                           |
| PlaneTrack on-time methodology, [planetrack.ai/on-time/#how-we-measure](https://www.planetrack.ai/on-time/#how-we-measure)                                                                                                                                                                                                                                                             | **Unverified.** HTTP 403 to us on 2026-11-21, with no archived copy. A reviewer (Sol) reports that it measures on a **UTC day**.                                                                                                                                                                                                                                                                                                                                             | Reported: UTC day. **A counterexample to "none use UTC"**                                                                        | n/a                                           |
| FAA ATCSCC advisory time zone, [fly.faa.gov/ois/help/index.html](https://www.fly.faa.gov/ois/help/index.html)                                                                                                                                                                                                                                                                          | **Unverified.** 404 on 2026-11-21 ("No static resource help/index.html"). `/ois/` redirects to nasstatus.faa.gov.                                                                                                                                                                                                                                                                                                                                                            | Not relied on. In-repo fact: our feed stamps `Update_Time` in GMT ([sources.md](../sources.md)), which is a timestamp, not a day | n/a                                           |

**What this supports, and no more.** Of the contracts checked, the Kalshi documents that state an
observation day use the airport-local day (AIRPORTDELAY, KXFLYCANCJFK). None of them uses a UTC day.
Every one states its trading and expiry times in ET. BTS reports in local time. One non-exchange
tracker (PlaneTrack, unverified by us) reportedly uses UTC, so "nobody uses UTC" is not claimed. A
20-airport panel spans four zones (10 airports Eastern: ATL JFK CLT MCO MIA EWR BOS FLL LGA DTW; 4
Central: DFW ORD IAH MSP; 2 Mountain: DEN PHX; 4 Pacific: LAX LAS SEA SFO), so no single
airport-local day exists. ET is the zone these contracts write their times in, and it is the local
zone of half the panel. That a multi-airport contract "would be written on an ET day" is the PM's
inference, not a sourced fact.

## 1. Day definition

A v2 day `D` (a `YYYY-MM-DD` date in ET) is the half-open interval
`[D 00:00 America/New_York, D+1 00:00 America/New_York)`, computed from the IANA zone. ET is UTC−5
(EST) or UTC−4 (EDT), always whole hours, so **every ET midnight is a UTC hour boundary and a slot
boundary**. Round ids, slots and receipts are unchanged: a round belongs to slot
`floor(fetchedAt, 5 min)` and is named by its UTC slot start (`2026-11-17T20:45Z`). Only the
grouping of slots into days changes.

| Day kind                             | Length | Slots | Hourly buckets | Max value (20 × minutes) |
| ------------------------------------ | ------ | ----- | -------------- | ------------------------ |
| Ordinary                             | 24 h   | 288   | 24             | 28,800                   |
| Spring forward (2nd Sunday of March) | 23 h   | 276   | 23             | 27,600                   |
| Fall back (1st Sunday of November)   | 25 h   | 300   | 25             | 30,000                   |

Hourly buckets stay UTC-hour-aligned and are keyed by UTC `hourStart`. On a fall-back day the local
hour 01:00 occurs twice, at 01:00 EDT (05:00Z) and 01:00 EST (06:00Z), and the buckets never
collide. The carry ladder restarts at each ET midnight.

The value is a count of airport-minutes, so a 25-hour day can count more than a 24-hour day and a
23-hour day less. This level effect is **stated, not normalized** (D6). A contract that wants
per-hour comparability can divide by the window length the print states.

**Settlement values (clarified for v2).** Only the panel totals are settlement values: `value` (ADI)
and `groundStopValue` (ADI-GS), on a `final` print. Per-airport minutes and the hourly series are
informational breakdowns. They are published and hashed but are never settlement values. The notice
states this.

### Coverage thresholds scale as percentages

Coverage = valid rounds / **that day's** slot count. The thresholds stay `finalMinPercent: 95` and
`degradedMinPercent: 80` and are compared in integers, as in v1: `valid × 100 ≥ percent × slots`,
with no rounding. The smallest passing count is `ceil(percent × slots / 100)`:

| Slots | `final` needs (95%)                  | `degraded` needs (80%)               | Rounds a `final` day can miss |
| ----- | ------------------------------------ | ------------------------------------ | ----------------------------- |
| 276   | 95 × 276 = 26,220 → **263** (262.2↑) | 80 × 276 = 22,080 → **221** (220.8↑) | 13                            |
| 288   | 95 × 288 = 27,360 → **274** (273.6↑) | 80 × 288 = 23,040 → **231** (230.4↑) | 14                            |
| 300   | 95 × 300 = 28,500 → **285** (exact)  | 80 × 300 = 24,000 → **240** (exact)  | 15                            |

A fixed count of 274 would ask a 276-slot day for 99.3% coverage and a 300-slot day for only 91.3%
(D5). `coverage.percent` stays display-only, `round(valid / slots × 100, 2)`.

## 2. Cutover

### Effective date: a lower bound, then fixed

Let `N` be the **recorded instant the notice became public**: the production deploy that serves the
incidents entry, read back from `/incidents` and recorded in the entry and in the registry
(`announcedAt`). The effective day `E` must satisfy `E 00:00 ET ≥ N + 30 × 24 h`. Each condition
gives only a lower bound on E.

**D1: target `E = 2027-01-01`**, possible only if `N ≤ 2026-12-02T05:00Z`. If the notice goes out
later, E moves to the first ET day that satisfies the bound, and the registry is changed before
merge. A registry test asserts `start(E) ≥ announcedAt + 30 d`. Once N is recorded, E is fixed.
Moving it later is a postponement (section 7).

### Release windows in the registry

| Release | `effectiveFrom` | `effectiveUntil` (new, inclusive) | Day        | First instant       | Last instant (excl.) |
| ------- | --------------- | --------------------------------- | ---------- | ------------------- | -------------------- |
| v1      | `2026-11-17`    | **`2026-12-31`** (E−1)            | UTC        | `2026-11-17T00:00Z` | `2027-01-01T00:00Z`  |
| v2      | `2027-01-01`    | (open)                            | America/NY | `2027-01-01T05:00Z` | n/a                  |

`effectiveUntil` is a registry field, not a hashed parameter, like `effectiveFrom`. The v1 parameter
object and its hash `e9ef6e94…c363` are untouched. `effectiveUntil` may change only before E, and
only through a postponement or withdrawal notice (section 7).

### The transition interval: no settlement day

**`[2027-01-01T00:00Z, 2027-01-01T05:00Z)` (5 h, 60 slots; 19:00 to 24:00 EST on 31 December)
belongs to no settlement day.** This is a first-class state, not an edge case:

```ts
type DayAt =
	| { kind: 'day'; release: Methodology; window: DayWindow }
	| { kind: 'transition'; previous: DayWindow; next: DayWindow };
dayAt(instant): DayAt   // the only function that maps an instant to a settlement day
```

`dayAt` returns `transition` for any instant after the end of the last day of a release with an
`effectiveUntil` and before the first instant of the next release. Every caller (running value,
settle default, collector, monitor-facing API, UI) handles `transition` explicitly. The type has no
fallback branch that could quietly use the wrong release.

Collection never stops. Gap rounds are collected and archived as usual, and they are tagged with the
release whose collection instant they follow: v1, because v2's first instant is 05:00Z. They count
in no settlement print. They appear in the **indicative** v2 print for ET day 2026-12-31 (section
4).

No cleaner cutover exists, because UTC and ET midnights never coincide:

| Option                                               | Why rejected                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Last v1 day UTC E, first v2 day ET E (overlap)       | 19 hours counted twice, and two settlement prints share the label E. |
| A one-off 60-slot v1 "stub day"                      | A day nobody would settle on, with its own coverage maths.           |
| A 29-hour first v2 day `[E 00:00Z, E+1 00:00 ET)`    | An exception in every rule and test, to cover 5 hours.               |
| Wait for EDT (≥ 2027-03-15) to shrink the gap to 4 h | Delays the change 10 weeks to save 1 hour.                           |

**D2: accept the gap.** The notice states it, with the instants and the slot count.

### No v1 print can carry a label ≥ E

Enforced in one place: `methodologyFor(label)` returns the release whose
`[effectiveFrom, effectiveUntil]` contains the label, and throws otherwise. `buildPrint`,
`printBody`, `settleDay`, `correctDay`, the indicative builder and `reproduce` all derive the
release this way, so none of them can be handed one. Tests (section 8, item 4): a property test over
labels E−3 to E+3 through each of those paths asserts that the release recorded in the output is v1
if and only if the label is ≤ E−1. Requesting a v1 print for E by any route (`?date=`, the
correction CLI, reproduce) is refused.

### Strict settlement admission (frozen)

v1's rule stays exactly as it is, for v1 and v2 settlement days alike. A round counts in a
settlement day only if it records **exactly** the version and parameter hash of the release in
effect on that day. Any other round is foreign: it takes no slot, and the day prints `suspended`
with the same `mixed methodology: …` reason string, byte for byte. v1 suspension output is frozen
and pinned by existing tests. Day E therefore needs v2-tagged rounds. A collector still running v1
code after 05:00Z on E would suspend E. That is today's rollout hazard, closed by the deployment
order and the rollback floor below. If v2 settlement ever needs to admit other identities, that is a
new, versioned, hashed admission policy with its own notice. v2.0.0 does not have one.

### Rollback floor

**The rollback floor is set before `E 00:00Z` (`2027-01-01T00:00Z`)** at the first production
deployment that has the release windows, `dayAt`, both print schemas (`adi.daily-print/1` and `/2`)
and the v2 key layout. From then on, no rollback target may predate it. This is written into
Operations, next to the existing adapter and correction floors.

Why it matters: an older deployment knows only v1. At `2027-01-02T00:30Z` its settle cron would
treat "UTC yesterday", 2027-01-01, as a v1 day and write a v1 UTC print for it. Two defences, both
tested:

1. **Separate keys.** v2 settlement prints live at `prints/et/{date}/r{n}.json`. v1 prints keep
   `prints/{date}/r{n}.json`. A stale v1 settle for label E writes `prints/2027-01-01/r1.json`. It
   can never occupy, block or overwrite the v2 print's key, and v2 code never serves it.
2. **Misfiled-print detection.** v2 code treats any object at `prints/{date}/…` with `date ≥ E` as a
   misfiled stale write. The day view and the settle run report it as a `misfiled_print` problem,
   and the monitor alerts on that. The real print is unaffected. History entries are rebuilt from
   the canonical keys, so a stale history update is repaired on the next settle.

Tests (section 8, item 5) run a stale v1 settle against the same `FileStore` archive before and
after the v2 settle, and assert the v2 print, the API response and the history entry are unchanged,
and that the misfiled print is reported.

## 3. Settlement timing

Every deadline is a fixed duration from an anchor the print states. v2 keeps the durations and
changes only where the day ends. All arithmetic is on instants, never on wall-clock times.

| Deadline                           | Anchor and duration                          |
| ---------------------------------- | -------------------------------------------- |
| Last admission (last slot +60 s)   | day end + 1 min                              |
| Settlement cutoff (`settlesAt`)    | day end + 30 min                             |
| Publication deadline (`publishBy`) | day end + 90 min                             |
| Corrections window                 | **`settlesAt` + 24 h**                       |
| Attestation cutoff, revision 1     | **day end + 24 h**                           |
| Attestation cutoff, correction     | **`correction.issuedAt` + 48 h** (zone-free) |

For v1 days these give exactly today's instants (D+1 00:30Z, D+1 01:30Z, D+2 00:30Z, D+2 00:00Z),
and golden tests pin them (section 6). Worked examples, all computed:

| Day                        | Day end                  | `settlesAt`              | `publishBy`              | Corrections until                   | r1 attestation cutoff               |
| -------------------------- | ------------------------ | ------------------------ | ------------------------ | ----------------------------------- | ----------------------------------- |
| 2026-12-31 (v1, UTC)       | 01-01 00:00Z             | 01-01 00:30Z             | 01-01 01:30Z             | 01-02 00:30Z                        | 01-02 00:00Z                        |
| 2027-01-01 (v2, EST)       | 01-02 05:00Z (00:00 EST) | 01-02 05:30Z (00:30 EST) | 01-02 06:30Z (01:30 EST) | 01-03 05:30Z (00:30 EST)            | 01-03 05:00Z (00:00 EST)            |
| 2027-03-13 (before spring) | 03-14 05:00Z (00:00 EST) | 03-14 05:30Z (00:30 EST) | 03-14 06:30Z (01:30 EST) | 03-15 05:30Z (**01:30 EDT**)        | 03-15 05:00Z (**01:00 EDT**)        |
| 2027-03-14 (23 h)          | 03-15 04:00Z (00:00 EDT) | 03-15 04:30Z (00:30 EDT) | 03-15 05:30Z (01:30 EDT) | 03-16 04:30Z (00:30 EDT)            | 03-16 04:00Z (00:00 EDT)            |
| 2027-11-06 (before fall)   | 11-07 04:00Z (00:00 EDT) | 11-07 04:30Z (00:30 EDT) | 11-07 05:30Z (01:30 EDT) | 11-08 04:30Z (**23:30 EST, 11-07**) | 11-08 04:00Z (**23:00 EST, 11-07**) |
| 2027-11-07 (25 h)          | 11-08 05:00Z (00:00 EST) | 11-08 05:30Z (00:30 EST) | 11-08 06:30Z (01:30 EST) | 11-09 05:30Z (00:30 EST)            | 11-09 05:00Z (00:00 EST)            |

US DST changes happen at 02:00 local, after that night's 00:30 and 01:30 deadlines, so `settlesAt`
and `publishBy` always read 00:30 and 01:30 ET. On the 2027-11-07 night, the 01:30 EDT deadline
comes first, before the hour repeats. The 24-hour durations read an hour off on the wall clock when
a DST change falls inside them (the bold cells above). That is by design: 24 hours stays exactly 24
hours.

### Settle cron (Vercel cron is UTC)

```json
{ "path": "/api/cron/settle", "schedule": "30,45 4,5 * * *" },
{ "path": "/api/cron/settle", "schedule": "0 5,6 * * *" }
```

In EDT the 04:30Z run settles and 04:45Z and 05:00Z retry. In EST 05:30Z settles and 05:45Z and
06:00Z retry. Either way the last retry is 30 minutes before `publishBy`, the same margin as today.
The v1 entries (`30 0`, `45 0`, `0 1`) stay until 2026-12-31 has printed, and are removed in the
post-cutover PR.

Route behaviour:

- Without `?date`, it gathers **every settlement day whose `settlesAt` passed within the last 48 h**
  (UTC- and ET-labelled alike) and attempts **each one independently**. One date failing (an
  unreadable receipt) never blocks another. The response lists a per-date outcome: `settled`,
  `already_settled` (history repaired), `failed` with the reason, or, when the list is empty,
  `nothing_due` with status 200 instead of today's 409.
- The `already_settled` path still repoints history at the latest revision, as today.
- `?date=` still settles **any** past day whose cutoff has passed, with no 48-hour limit. This is
  the operator's recovery path.
- During the transition interval, the default list contains 2026-12-31 (v1) until it prints. It
  never contains a label for the gap.

### Attest workflow (GitHub Actions is UTC)

Schedules: the legacy `45 1 * * *` stays until 2026-12-31 is attested, plus new `45 5 * * *` and
`45 6 * * *`.

- **Targeting.** A run reconciles the settlement days in the 7 days ending on the run's reference
  date. For the legacy 01:45Z trigger that is the **UTC** date of `created_at` minus 1, unchanged.
  For the 05:45Z and 06:45Z triggers it is the **ET** date of `created_at` minus 1.
- **Gate on each date's actual `publishBy`.** For each candidate date the run reads
  `/api/v1/days/{date}`. Unsettled with `now < publishBy` is a **skip** ("not yet published"), not a
  failure. Unsettled with `now ≥ publishBy` fails the run, as today, because a print is overdue.
  Settled means attest or check, as today.
- **Delayed starts** (GitHub can start a scheduled run hours late) only move `now` later, so the
  gate becomes more permissive, never wrong. **Duplicate runs** are idempotent: an attestation is
  never rewritten, and the workflow keeps one concurrency group so two runs never push at once.
- Indicative prints are **never** attested here (section 4).

### Monitor (`lexabu/personal-configs` `scripts/adi-monitor.sh`)

Clock maths leaves the shell. Every 5-minute tick:

- **Heartbeat:** reads `lastRound.fetchedAt` from `/api/v1/current`. That field is always present,
  including during the transition interval (section 5), so the stall check never reads a missing day
  as a stall.
- **Daily prints:** the candidate dates are {UTC yesterday, ET yesterday} **∪ every date with an
  open late alert**, kept even after it leaves the window. For each, GET `/api/v1/days/{date}`:
  `200 settled` gives a recovery or non-final notice, as today. `404 unsettled` alerts once
  `now ≥ publishBy + 10 min`, with `publishBy` taken from the response body. A `misfiled_print`
  problem alerts immediately.
- It ships as its own PR in `lexabu/personal-configs` and is live **before** the v2 deployment.
  Dry-run tests are in section 8, item 10.

## 4. Indicative ET series during the notice period

Receipts are unchanged and archived from `2026-11-20T04:30Z`. An ET day is a pure function of its
receipts, so v2 values for past ET days can be computed now, without backfilling any source data. ET
`2026-11-20` starts at `05:00Z`, after the first round, so it is the first ET day with full
collection. (ET `2026-11-19` has 6 rounds.)

### Admission: the only place compatibility exists

The indicative series runs **the same aggregation code** as settlement (`aggregateDay`, the ladder,
coverage, `printBody`). The only difference is the admission predicate passed in:

- settlement: `isUnder(dayRelease)`, strict and frozen (section 2).
- indicative: the hashed **indicative admission policy** `adi.indicative-admission/1`, which admits
  rounds recording exactly `{1.0.0, e9ef6e94…c363}` or `{2.0.0, <v2 hash>}`. Each admitted receipt
  is verified under **its own recorded release and adapter** (`methodologyOf`, `adapterOf`), exactly
  as reproduce does. Any other identity, known or unknown, is foreign: it takes no slot, and the
  indicative print reports `suspended` with the same `mixed methodology` reason. The policy is
  explicit, not derived: v1 and v2 share receipt parameters (source, panel, observation checks), and
  a registry test asserts this, so v1 receipts are what v2 would have written. The policy object is
  embedded in every indicative print, so it is covered by `printHash`.

### Timing: freeze only after admission has drained

The indicative print for ET day D is built by the settle run **at or after D's v2 settlement
cutoff** (day end + 30 min: 04:30Z in EDT, 05:30Z in EST, so the same 04:30/05:30Z runs that settle
v2 days). By then the last admission (end + 1 min) has closed and admitted writes have drained (≤ 60
s more). It is written once (`if-absent`) and never revised. Past days, from 2026-11-20, are written
at launch by `npm run indicative -- --from 2026-11-20`, which uses the same builder with the same
cutoff guard.

### Proof: complete in-window set, both directions, against v1 attestations

ET day D's window lies in UTC partitions D and D+1, both v1 days for every indicative D ≤ E−2. Each
v1 print lists **every** receipt of its UTC day, and is attested. So:

- `reproduce --indicative D` rebuilds the print, then takes the **verified attestations** of v1 days
  D and D+1 (`verify-attestation` semantics: proofs before their cutoffs) and checks that {receipts
  of those two v1 prints with a slot in D's window} **equals** {receipts listed by the indicative
  print}. Nothing is omitted and nothing is added. A v1 attestation that is not yet available gives
  `PENDING` (exit 4), not `MATCH`.
- The attest workflow runs this check for each indicative day once both of its v1 days are attested,
  and fails on a mismatch. It writes **no** indicative attestation files. The attestations branch
  stays settlement-only.
- **E−1 (2026-12-31 ET) has no complete external pin.** Its window is
  `[2026-12-31T05:00Z, 2027-01-01T05:00Z)`. The slots `[2027-01-01T00:00Z, 05:00Z)` (the gap, 60
  slots) are in partition 2027-01-01, which has no v1 print. They can be reproduced from the
  archive, but nothing outside the operator's storage pins them. `reproduce --indicative 2026-12-31`
  checks the 228 pinned slots both ways and reports the 60 gap slots as `unpinned`. The notice says
  so.

### Labels and standing

- Every indicative representation carries the ET suffix and its standing:
  - series names: **"ADI (ET, indicative)"** and **"ADI-GS (ET, indicative)"**;
  - JSON: `standing: 'indicative'` and `day: 'America/New_York'` on every print, history entry and
    `current` block;
  - site: a badge on every value, chart legend and table heading;
  - any future export (CSV): columns `standing` and `day`, plus an `_et_indicative` suffix on the
    file name.
- Endpoints are separate: `GET /api/v1/indicative/days/{date}` (2026-11-20 ≤ date ≤ E−1; a date ≥ E
  gives 404 with `see: /api/v1/days/{date}`) and `GET /api/v1/indicative/history`.
- **Settlement standing is enforced at the canonical boundaries**, by type and by schema:
  `SettlementPrint` and `IndicativePrint` are distinct types. `/api/v1/days`, `/history`,
  `correctDay`, `scripts/correct.ts`, `buildAttestation`, `verify-attestation` and the attest
  workflow accept only `standing: 'settlement'`, and the schema refuses an indicative print there.
- **How it becomes the settlement series.** It does not. From E on, the same code under the same
  release writes settlement prints at `/api/v1/days/{date}`. Indicative prints for days before E
  stay published, frozen and labelled indicative forever. They are never relabelled, promoted or
  corrected. The ET track record is the indicative series through E−1 followed by the settlement
  series from E. The site draws them as one ET chart, with the indicative part visibly distinct.

## 5. Data model and API

### Registry

`MethodologyParameters` becomes a union discriminated on `day`, so v1's hashed object is untouched:

```ts
type V1Parameters = CommonParameters & { day: 'utc'; slotsPerDay: 288 };
type ZonedParameters = CommonParameters & { day: { timeZone: 'America/New_York' } };
export type MethodologyParameters = V1Parameters | ZonedParameters;
type Methodology = {
	parameters;
	parameterHash;
	effectiveFrom: DayLabel;
	effectiveUntil: DayLabel | null;
	announcedAt: string | null;
};
```

v2 drops `slotsPerDay`, because it is no longer constant, and adds the hashed time zone. The
module-level `SLOTS_PER_DAY` is removed.

### One owner of day windows (`src/lib/index/time.ts`)

`dayWindow(release, label) → { date, start, end, slots }` and `dayAt(instant)` (section 2) are the
only boundary computations. Every deadline takes a `DayWindow`. `parseRoundId` no longer returns a
day. A branded `UtcDate` is kept for **storage partitions** only. Settlement days use a separate
`DayLabel`.

### Prints and storage

- v1 prints: `adi.daily-print/1` at `prints/{date}/r{n}.json`, unchanged.
- v2 settlement prints: `adi.daily-print/2` at `prints/et/{date}/r{n}.json`.
- Indicative prints: `adi.daily-print/2` at `indicative/2.0.0/{date}.json`.
- `/2` adds, inside the hash: `window {start, end}`, `standing`, and for indicative prints
  `admission` (the policy object). `coverage.slotsPerDay` is 276, 288 or 300. `hourly` has 23 to 25
  entries.
- `printSchema` is a union, so every stored `/1` print parses and hashes exactly as before.
  `readCorrectionPrints` lists both key prefixes.

### Settlement reads (window-filtered)

1. List the receipt ids of UTC partitions D and D+1 (two `list` calls, no reads).
2. **Filter the ids to slots inside the window before reading anything.** At most 300 ids remain.
3. Read and verify only those, with today's rule: any unreadable or unverifiable **in-window**
   receipt stops that date's run, and the next retry tries again. An out-of-window receipt is never
   read, so it can never block a print.

**Partition day indexes are decoupled.** `days/{utcDate}.json` stays a cache of one UTC partition,
owned by collect. v2 settle and correct no longer rebuild it (v1 settle keeps doing so for v1 days,
unchanged). The running value reads the two partition indexes and filters to the window.

### API

- `/api/v1/days/{date}`: a label ≤ E−1 is a v1 UTC day, a label ≥ E is a v2 ET day. Every response
  states `methodologyVersion`, `standing` and `window`. The unsettled 404 body also states `window`,
  `settlesAt` and `publishBy`.
- `/api/v1/current` (the response is a union on `status`):
  - `provisional`: today's settlement day, as now, plus `window`.
  - **`transition`**:
    `{ status: 'transition', asOf, previousDay: {date, window, settlesAt, publishBy}, nextDay: {date, window}, lastRound }`,
    with no value, coverage or slots.
  - **The heartbeat (`asOf`, `lastRound`) is outside the day block and present in both shapes.**
- `/api/v1/history`: entries gain `methodologyVersion`, `standing` and `window`. The default `to` is
  the latest day whose cutoff has passed.
- `/api/v1/methodology`: during the notice period adds
  `upcoming: { version, parameterHash, effectiveFrom, effectiveAt, announcedAt }`. During the
  transition interval it reports v2 as `upcoming`, with no `current` day.
- `/api/v1/rounds/{id}`: unchanged.

### UI

- Day headings: "Thursday 2027-01-07 (ET)"; before E, "… (UTC)".
- Every instant is shown in **ET and UTC** (server-rendered) plus the **viewer's local time** (a
  small client component, `<time dateTime>` with `Intl.DateTimeFormat`).
- Hourly chart: 23 to 25 bars, labelled in ET with the UTC hour in the tooltip. The repeated
  fall-back hour is labelled "01:00 EDT" and "01:00 EST".
- **Transition interval** (`/`, `/status`): "Between settlement days. UTC day 2026-12-31 has ended
  (print due 2027-01-01 01:30Z). ET day 2027-01-01 starts at 05:00Z (00:00 EST). Collection
  continues: last round …".
- Notice period: a banner on `/`, `/methodology` and `/status`, and the "ADI (ET, indicative)"
  chart.
- `/methodology` describes v2 from E. The v1 text moves, unchanged, to a "v1.0.0 (UTC day), days
  2026-11-17 to 2026-12-31" annex.

## 6. Reproduce and verify, v1 forever

- **One v1 verifier for every v1 format:** receipts from adapter `faa-nas-xml/1` (no
  `adapterVersion`) and `faa-nas-xml/2`; revision 1 and correction prints (with `issuedAt`,
  `windowOverride`); `adi.attestation/1` files and their `.ots` proofs. v1 code paths read the same
  parameters, use the same keys and compute the same instants.
- **End-to-end pinned fixtures:** a committed snapshot of real production v1 data, covering at least
  one day per adapter, one partial day (2026-11-20, `degraded`), a correction if one exists by then
  (otherwise a test-store correction), and the attestation and proof for each. A test runs
  `reproduce` and `verify-attestation` against a fixture API serving those exact bytes, and must
  print `MATCH`. The test pins every `printHash`, `receiptHash`, `settlesAt`, `publishBy`,
  correction deadline and attestation cutoff. Historical bytes and deadlines are identical by
  construction and by test.
- `/2` prints: `reproduce` also checks `window` against its own tz computation, so a tzdata
  disagreement becomes `MISMATCH` with the field named.
- `reproduce --indicative` is covered in section 4. The tag `v1.0.0` keeps reproducing v1. The
  release commit is tagged `v2.0.0`.

## 7. Public notice

### Incident log entry (`docs/incidents.md`, newest first)

> **2026-MM-DD (published at `<N, recorded ISO instant>`): methodology v2.0.0 announced, effective
> ET day 2027-01-01.**
>
> - **What changes.** From ET day 2027-01-01, each settlement print covers the civil day in
>   America/New_York (US Eastern), `[00:00, 24:00)` ET, instead of the UTC day. Ordinary days have
>   288 five-minute slots. The second Sunday of March has 23 hours (276 slots), and the first Sunday
>   of November has 25 hours (300 slots). 2027-01-01 itself is an ordinary 288-slot day,
>   `[2027-01-01T05:00Z, 2027-01-02T05:00Z)`. It settles at 2027-01-02T05:30Z (00:30 EST) and is
>   published by 06:30Z (01:30 EST).
> - **What does not change.** The source, panel, slots, observation checks, carry ladder, coverage
>   percentages (95% / 80% of the day's slots) and the durations of every deadline. The parameter
>   hash changes to `<v2 hash>`.
> - **The last UTC print is 2026-12-31.** **The 5 hours from 2027-01-01T00:00Z to 05:00Z (19:00 to
>   24:00 EST on 31 December, 60 slots) are in no settlement print.** They are collected and
>   archived, and shown only in the indicative series. They have no external attestation.
> - **Rule changes.** Rule 4's requirement that a version "takes effect only at 00:00Z of a UTC day"
>   is amended. A version takes effect at the start of its first day under its own boundary, and the
>   instants between the previous release's last day and that start belong to no settlement day.
>   Admission stays strict: a settlement day counts only rounds collected under exactly its own
>   version and parameter hash. Only the panel totals (ADI and ADI-GS) are settlement values;
>   per-airport and hourly figures are informational.
> - **Indicative series.** Until then, an indicative ET series, computed under v2 from the same
>   archived receipts, is at `/api/v1/indicative/…`, labelled "ADI (ET, indicative)". It is never a
>   settlement value. Its admission policy accepts receipts collected under v1.0.0 or v2.0.0 and is
>   stated in every indicative print.
> - **For exchanges and contract writers.** Pin the `parameterHash` (and version) in contract rules.
>   Do not write multi-day aggregates (weekly, monthly) that span 2026-12-31 and 2027-01-01: they
>   would mix a UTC day, the gap and an ET day. No v1 print is changed or corrected. Corrections are
>   never used to apply v2 to past days (rule 8).
> - **Postponement or withdrawal.** Any postponement or withdrawal is announced on this log before
>   2027-01-01T00:00Z. A postponed v2 takes effect no earlier than 30 days after the postponement
>   notice (a fresh 30 days), on a stated ET day. A withdrawn v2 leaves v1 in effect with no end
>   date. Either way, no day is ever printed under two methodologies.
>
> Discussion: issue #<n>.

### Methodology changes (`docs/methodology.md`)

- A new **"Version history"** section:
  - **v2.0.0, effective ET day 2027-01-01, announced `<N>`.** Day boundary UTC → America/New_York.
    Slots per day 288 → 276/288/300. Thresholds as percentages of the day's slots. Deadlines
    unchanged as durations. Rule 4 amended (text above). Settlement values clarified. Parameter hash
    `<v2 hash>`.
  - **v1.0.0, UTC days 2026-11-17 to 2026-12-31.** As published.
- **Rule 4, amended text** (published with the notice, in force from E): "A new methodology version
  takes effect at the start of its first day, under that version's day boundary, and is announced on
  the incident log at least 30 days before. The instants between the end of the previous version's
  last day and that start belong to no settlement day. …" The rest of rule 4 is unchanged.
- The DST annex below is copied in as normative.

Rule 4 governs the announcement. Rule 8 applies only as a prohibition: no v1 day is reprinted under
v2.

## 8. Risks and test plan

### Risks

| Risk                                                                   | Mitigation                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stale v1 deployment settles label E as a UTC day                     | Rollback floor before E 00:00Z; separate v2 keys; misfiled-print detection and alert; tests on the shared archive (section 2).                        |
| A collector on v1 code past E 05:00Z suspends day E                    | Deploy before E; rollback floor; monitor shows `foreignMethodologies` the same day.                                                                   |
| tzdata differs, or US DST law changes                                  | Past days do not move (tzdata keeps history). `/2` prints state `window`, and `reproduce` names a disagreement. A law change is reviewed as a v3.     |
| A reader mistakes a label's zone (2026-12-31 is UTC, 2027-01-01 is ET) | `window`, `methodologyVersion`, `standing` and the zone in every response and beside every date on the site.                                          |
| An indicative value is cited as settlement                             | Separate endpoints, the ET-indicative suffix everywhere, `standing` in the hash, distinct types, schema refusal at canonical boundaries.              |
| A multi-day contract spans the cutover                                 | The notice forbids it and tells writers to pin `parameterHash`.                                                                                       |
| Settle crons misfire around DST or the cutover                         | Per-date independent attempts, `nothing_due`, explicit-date recovery, monitor deadlines read from the API.                                            |
| Monitor or attest changes ship late                                    | Both are dated cutover checklist items. The legacy schedules stay until 2026-12-31 is done.                                                           |
| Two partitions per settle widen the read surface                       | Ids are filtered to the window before any read: **at most 300 reads**. Only in-window receipts can stop a run. Out-of-window receipts are never read. |
| The gap holds the worst disruption of the evening                      | Stated in the notice (D2).                                                                                                                            |

### Test plan (phase 2)

1. **Windows.** `dayWindow` for v1 labels is UTC. For ET, `2027-03-14` has 276 slots, `2026-11-01`
   and `2027-11-07` have 300, and an ordinary day has 288. Property test, every ET date 2026–2035:
   windows tile, lengths are 23, 24 or 25 h, starts are 5-minute aligned. `dayAt` round-trips.
2. **Coverage** boundaries: 262/263, 220/221, 273/274, 230/231, 284/285, 239/240.
3. **Aggregation:** 23 and 25 hourly buckets, the repeated fall-back hour, and a ladder that
   restarts at ET midnight.
4. **Cutover and labels:** registry windows; `dayAt` gives `transition` for the whole of
   `[E 00:00Z, E 05:00Z)` and nothing else. Property test over labels E−3 to E+3 through
   `buildPrint`, `settleDay`, `correctDay`, the settle route (`?date` and default), the correction
   CLI, the indicative builder and `reproduce`: the release is v1 if and only if the label is ≤ E−1,
   and a v1 print for a label ≥ E is impossible on every path.
5. **Rollback and stale writes:** on one `FileStore`, a stale v1 settle for label E, run before and
   after the v2 settle, leaves the v2 print, API and history unchanged, and `misfiled_print` is
   reported. The converse also holds: v2 code never writes under `prints/{date}` for labels ≥ E.
6. **Admission:** settlement on a v2 day with one v1-tagged round prints `suspended` with the frozen
   reason. Indicative admits v1 and v2 identities. A known-incompatible identity (a test release
   with a different panel) and an unknown identity are foreign in both. Each admitted receipt is
   verified under its own release and adapter. A test asserts v1 and v2 receipt parameters are
   equal.
7. **Settle route:** per-date independence (one failing date, the others settle); `nothing_due`;
   history repair on `already_settled`; `?date` beyond 48 h; both DST nights; the cutover night.
8. **Window-filtered reads:** out-of-window corrupt receipts do not block; an in-window one does; ≤
   300 reads; partition indexes are untouched by v2 settle and correct.
9. **Schemas and standing:** v1 fixture prints parse and hash unchanged; the v1 parameter hash is
   unchanged; the v2 hash is pinned; `/2` without `window` or `standing` is refused; an indicative
   print is refused by `/days`, `correctDay`, `buildAttestation` and `verify-attestation`.
10. **Monitor dry runs** (`--now`): `2027-01-01T00:05Z` (transition, heartbeat fresh, no false
    stall); `2027-01-01T01:40Z` (v1 2026-12-31 alert path); `2027-01-01T05:05Z` (first v2 slot,
    nothing due); `2027-01-02T06:40Z` (2027-01-01 alert path); `2027-03-14T06:40Z` (EST alert);
    `2027-03-15T05:40Z` (EDT alert); an open alert kept after it leaves the window; a
    `misfiled_print` alert. Silent before each `publishBy + 10 min`.
11. **Attest workflow:** UTC targeting on the legacy trigger and ET targeting on the new ones; a
    "not yet published" skip; an overdue failure; delayed starts; duplicate runs; both DST nights
    and the cutover.
12. **Indicative proof:** the both-ways set check passes; it fails with one receipt omitted and with
    one extra; `PENDING` before the v1 attestations exist; E−1 reports exactly 60 `unpinned` gap
    slots.
13. **v1 end-to-end fixtures** (section 6): `MATCH` with every pinned byte and deadline.
14. **API and UI at both boundaries** (`E 00:00Z` and `E 05:00Z`): `/current` switches `provisional`
    → `transition` → `provisional`; `/days`, `/methodology` and `/` render each state; ET, UTC and
    local rendering; DST-day charts.
15. **After cutover** (checklist): reproduce 2026-12-31 and 2027-01-01, both `MATCH`; then remove
    the v1 crons and the 01:45Z attest run.

## Decisions for review

| #   | Decision                  | Recommendation                                                                                                  |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | Effective date            | Target 2027-01-01. Lower bound: start ≥ recorded N + 30 d. Fixed once N is recorded.                            |
| D2  | 5 h cutover gap           | Accept and state it, with no settlement day for those instants.                                                 |
| D3  | Admission                 | Strict and frozen for settlement. A hashed policy for indicative only.                                          |
| D4  | Indicative series         | Separate endpoints and keys, ET-indicative labels, `standing` in the hash, no own attestation, both-ways proof. |
| D5  | Thresholds                | Percentages of the day's slots.                                                                                 |
| D6  | Values on 23/25-hour days | Not normalized. Stated.                                                                                         |
| D7  | Settlement values         | Panel totals only (ADI, ADI-GS). Breakdowns informational.                                                      |

## Settlement annex: the DST rule

Normative for v2. Copied into `docs/methodology.md` at release.

1. **Days follow America/New_York.** Day D is `[D 00:00, D+1 00:00)` in the IANA zone
   `America/New_York`, under the US DST rules in force for that date.
2. **Slot counts.** An ordinary day is 24 h, **288** slots. The spring-forward day (second Sunday of
   March) is 23 h, **276** slots. The fall-back day (first Sunday of November) is 25 h, **300**
   slots.
3. **Slots stay 5-minute, UTC-aligned.** A slot is `[t, t + 5 min)` with `t` a multiple of 5 minutes
   since the Unix epoch. Round ids are the UTC slot start. ET midnight is always a whole UTC hour,
   so a day is always a whole number of slots.
4. **Sample days** (exact UTC bounds, end exclusive):

   | ET day       | Kind                       | Starts (UTC)                       | Ends (UTC)                         | Length | Slots   |
   | ------------ | -------------------------- | ---------------------------------- | ---------------------------------- | ------ | ------- |
   | `2027-03-14` | spring forward             | `2027-03-14T05:00:00Z` (00:00 EST) | `2027-03-15T04:00:00Z` (00:00 EDT) | 23 h   | **276** |
   | `2026-11-01` | fall back (worked example) | `2026-11-01T04:00:00Z` (00:00 EDT) | `2026-11-02T05:00:00Z` (00:00 EST) | 25 h   | **300** |
   | `2027-11-07` | fall back (first under v2) | `2027-11-07T04:00:00Z` (00:00 EDT) | `2027-11-08T05:00:00Z` (00:00 EST) | 25 h   | **300** |
   | `2027-01-01` | ordinary (EST)             | `2027-01-01T05:00:00Z` (00:00 EST) | `2027-01-02T05:00:00Z` (00:00 EST) | 24 h   | **288** |

5. **Coverage thresholds are percentages of that day's slot count.** Status is decided in integers
   with no rounding: `final` iff `valid × 100 ≥ 95 × slots`; else `degraded` iff
   `valid × 100 ≥ 80 × slots`; else `suspended`. The minimum counts are 263/221 (276 slots), 274/231
   (288) and 285/240 (300). `coverage.percent = round(valid / slots × 100, 2)` is for display only.
6. **Deadlines are durations, on instants:** `settlesAt` = end + 30 min; `publishBy` = end + 90 min;
   corrections until `settlesAt` + 24 h; r1 attestation cutoff = end + 24 h; correction attestation
   cutoff = `issuedAt` + 48 h. On a fall-back night, `publishBy` is the first 01:30 ET (EDT).

## Round 1 review dispositions

| Id                     | Disposition                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 / S2 (blocker)      | Done. v1 `effectiveUntil`, `dayAt` → `transition`, `/current` transition shape with a separate heartbeat, the no-v1-label-≥-E property test, API/UI/monitor tests at both boundaries (sections 2, 3, 5, 8).                                                                                                                                 |
| S1 / O7 (blocker)      | Done. Settlement admission strict and frozen; indicative-only hashed admission policy with shared aggregation; per-receipt release and adapter verification; incompatible and unknown identity tests; disclosed in the notice (sections 2, 4, 7, 8).                                                                                        |
| S3 (blocker)           | Done. Rollback floor before E 00:00Z; separate v2 keys; misfiled-print detection; stale-settle tests on the shared archive (section 2, tests 5).                                                                                                                                                                                            |
| S4 (blocker)           | Done. Ids filtered to the window before reads; partition indexes decoupled from v2 settle and correct; risk table fixed to ≤ 300 reads (sections 5, 8).                                                                                                                                                                                     |
| O2 / O3 / S5 (blocker) | Done. Frozen at or after the v2 cutoff runs; both-ways set check against verified v1 attestations, `PENDING` until available; E−1 gap slots stated as unpinned (section 4).                                                                                                                                                                 |
| S6                     | Done. E is a lower bound; N recorded (`announcedAt`); explicit rule 4 amendment (sections 2, 7).                                                                                                                                                                                                                                            |
| O5                     | Done. Pin `parameterHash`, no multi-day aggregates across E, postponement and withdrawal with a fresh 30 days (section 7).                                                                                                                                                                                                                  |
| O4 / S11               | Done. ET-indicative suffix and standing on every representation; settlement standing enforced by type and schema at the API, correction and attestation (section 4).                                                                                                                                                                        |
| O6 / S10               | Done. Gate on each date's `publishBy` (skip vs fail), UTC legacy targeting kept, delayed and duplicate runs (section 3, test 11).                                                                                                                                                                                                           |
| S9                     | Done. Per-date independent settle, history repair, unlimited `?date` recovery, monitor keeps open alerts (section 3).                                                                                                                                                                                                                       |
| S8                     | Done. Anchors corrected (corrections from `settlesAt`, r1 from day end, corrections' attestation from `issuedAt` + 48 h), with computed DST examples (section 3). Sol's own examples were not in the relay, so these were recomputed and are open to check.                                                                                 |
| S12                    | Done. One v1 verifier for all formats; end-to-end pinned production fixtures (section 6, test 13).                                                                                                                                                                                                                                          |
| S7                     | Done. Conclusion limited to the contracts checked; observation vs trading/expiry columns; GLOBALTEMPERATURE observation zone unspecified; BTS quoted (via the Wayback snapshot, since the live page is 403 to us); PlaneTrack noted as a counterexample, marked unverified (403, no archive); normalization analogy removed (section 0, 1). |
| O8                     | Done. Panel totals only; breakdowns informational; in the notice (section 1, 7, D7).                                                                                                                                                                                                                                                        |
| O9                     | Done. Slot counts in the annex table and the notice.                                                                                                                                                                                                                                                                                        |
