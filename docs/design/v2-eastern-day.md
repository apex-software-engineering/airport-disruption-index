# Design: methodology v2.0.0, the US Eastern day

Status: **draft for review, revision 3** (phase 1, no code). Refs #11. Review dispositions for
rounds 1 and 2 are listed at the end.

Methodology v2.0.0 changes one thing: the day a settlement print covers. v1 counts the UTC day. v2
counts the civil day in **America/New_York** (US Eastern, "ET"). The slot grid, the source, the
panel, the observation checks, the carry ladder and the coverage percentages are unchanged. Every v1
print, receipt and attestation keeps settling, reproducing and verifying under v1, byte for byte,
forever.

Decisions this review should settle are marked **D1** to **D8** and collected at the end.

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
| PlaneTrack on-time methodology, [planetrack.ai/on-time/#how-we-measure](https://planetrack.ai/on-time/#how-we-measure)                                                                                                                                                                                                                                                                 | "Departures are counted by scheduled day (UTC)." **Verified** by reviewer Sol (round 3). The page returns HTTP 403 to our own fetchers, so this quote rests on Sol's reading.                                                                                                                                                                                                                                                                                                | **UTC day** (by scheduled departure). **A counterexample to "none use UTC"**                                                     | n/a                                           |
| FAA ATCSCC advisory time zone, [fly.faa.gov/ois/help/index.html](https://www.fly.faa.gov/ois/help/index.html)                                                                                                                                                                                                                                                                          | **Unverified.** 404 on 2026-11-21 ("No static resource help/index.html"). `/ois/` redirects to nasstatus.faa.gov.                                                                                                                                                                                                                                                                                                                                                            | Not relied on. In-repo fact: our feed stamps `Update_Time` in GMT ([sources.md](../sources.md)), which is a timestamp, not a day | n/a                                           |

**What this supports, and no more.** Of the contracts checked, the Kalshi documents that state an
observation day use the airport-local day (AIRPORTDELAY, KXFLYCANCJFK). None of them uses a UTC day.
Every one states its trading and expiry times in ET. BTS reports in local time. One non-exchange
tracker, PlaneTrack, counts "by scheduled day (UTC)", so "nobody uses UTC" is not claimed. A
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

### Effective date: a lower bound, published in two steps

A deployment cannot contain the instant at which it became public. So N is recorded by a second
deployment, after the first has been read back:

1. **Step 1, the notice deploy.** This ships the incidents entry, the version-scoped v2 rules
   (section 7), the indicative series, and v2 in the registry with `effectiveFrom: 2027-01-01` and
   `announcedAt: null`. **While `announcedAt` is null, v2 is never in effect.** `dayAt` and the
   settlement lookup ignore it, v1 has no `effectiveUntil`, and the collector keeps tagging v1. Only
   the indicative series (which selects v2 explicitly, see below) and `/api/v1/methodology`'s
   `upcoming` block use it.
2. **Readback: one record.** A Vercel `ready` timestamp is not used, because a deployment can be
   ready before it serves production traffic. Instead, a `notice-readback` GitHub Actions workflow
   runs after step 1 deploys, by hand and then every 15 minutes until it succeeds. It fetches
   `https://airports.apexsofteng.com/incidents` and `/api/v1/methodology` over the public internet.
   It succeeds only when both show the notice: the incidents entry text, and the `upcoming` v2 block
   with its parameter hash.
   - **A failed run writes nothing.** The workflow is simply run again.
   - **The one successful run writes a single write-once record**, `notices/2.0.0.readback.json`, to
     the attestations branch. It holds the run id, GitHub's `run_started_at`, each response's `Date`
     header and `X-Deployed-Commit`, and the sha256 of each body.
   - **N = max(the `Date` headers, `run_started_at`).**
   - The record is stamped with OpenTimestamps like a print. **B** is the header time of the
     earliest Bitcoin block its proof reaches. If a proof is ever lost, the same bytes are stamped
     again. B is then the new, later block time, which can only push E later.
   - The record is never rewritten.

   **The notice bound is `max(N, B) + 30 × 24 h`.** N is when the notice was demonstrably public. B
   is when an independent timestamp proves the record existed. Using the later of the two needs no
   check that B ≥ N, and no clock can make the bound earlier.

3. **Step 2, the registry deploy.** Once the record's proof has a block, a follow-up PR sets v2
   `announcedAt: N`, `announcedProofAt: B` and v1 `effectiveUntil: E−1`. It adds "public from N
   (readback run `<id>`, `notices/2.0.0.readback.json`)" to the incidents entry. Step-2 CI verifies
   the single record and one inequality, and refuses the PR otherwise:
   - the record's bytes are as first committed;
   - the record's N and the proof's B match the registry;
   - the proof verifies;
   - `effectiveAt(v2) ≥ max(N, B) + 30 × 24 h`.

   **This deployment is the rollback floor** (below). Until it deploys there is no cutover to
   protect.

**When the cutover happens.** v1 rule 4 says a new version "takes effect only at 00:00Z of a UTC
day" and is announced at least 30 days before. v2 complies as written:

- v2 **takes effect at `2027-01-01T00:00Z`**, the end of v1's last day (`effectiveAt`);
- **its first settlement day starts at `2027-01-01T05:00Z`** (00:00 EST);
- the five hours between are v2's, but belong to no settlement day (below).

No rule is amended. The cutover happens only if all three hold:

- `effectiveAt(v2) ≥ max(N, B) + 30 × 24 h`;
- step 2 is deployed to production before `effectiveAt(v2)`;
- v2 has not been postponed or withdrawn by the postponement close.

If any condition fails, v1 simply continues. With no `effectiveUntil`, no gap and no v2 day exist.

**D1: target `E = 2027-01-01`**, possible only if `max(N, B) ≤ 2026-12-02T00:00Z`. If it is later, E
is the first ET day whose `E 00:00Z` satisfies the bound, and step 2 states it. E can change after
step 2 only by a postponement (section 7), which **closes 14 days before `effectiveAt`**
(`2026-12-18T00:00Z` for this E). After that, E is fixed.

### Release windows in the registry

| Release | `effectiveFrom` | `effectiveUntil` (new, inclusive) | Day        | First instant                                                                     | Last instant (excl.) |
| ------- | --------------- | --------------------------------- | ---------- | --------------------------------------------------------------------------------- | -------------------- |
| v1      | `2026-11-17`    | **`2026-12-31`** (E−1)            | UTC        | `2026-11-17T00:00Z`                                                               | `2027-01-01T00:00Z`  |
| v2      | `2027-01-01`    | (open)                            | America/NY | takes effect `2027-01-01T00:00Z`; first settlement day starts `2027-01-01T05:00Z` | n/a                  |

`effectiveUntil` is a registry field, not a hashed parameter, like `effectiveFrom`. The v1 parameter
object and its hash `e9ef6e94…c363` are untouched. `effectiveUntil` is set only by step 2. After
that it changes only through a postponement or withdrawal notice issued before the postponement
close (section 7), and each such change **advances the rollback floor** to the deployment that
carries it. A rollback can therefore never restore a superseded cutover. Code never hard-codes E.
Every use (`dayAt`, misfiled-print detection, history and correction filters, the monitor via the
API) derives it from the registry as the label after v1's `effectiveUntil`.

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
`effectiveUntil` and before the start of the next release's first settlement day. Every caller
(running value, settle default, collector, monitor-facing API, UI) handles `transition` explicitly.
The type has no fallback branch that could quietly use the wrong release.

Collection never stops. Gap rounds are collected and archived as usual. They are tagged with the
release in effect at their collection instant: v2, which takes effect at 00:00Z. They count in no
settlement print. They appear in the **indicative** v2 print for ET day 2026-12-31 (section 4).

No cleaner cutover exists, because UTC and ET midnights never coincide:

| Option                                               | Why rejected                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Last v1 day UTC E, first v2 day ET E (overlap)       | 19 hours counted twice, and two settlement prints share the label E. |
| A one-off 60-slot v1 "stub day"                      | A day nobody would settle on, with its own coverage maths.           |
| A 29-hour first v2 day `[E 00:00Z, E+1 00:00 ET)`    | An exception in every rule and test, to cover 5 hours.               |
| Wait for EDT (≥ 2027-03-15) to shrink the gap to 4 h | Delays the change 10 weeks to save 1 hour.                           |

**D2: accept the gap.** The notice states it, with the instants and the slot count.

### Two lookups: canonical for settlement, explicit for indicative

The release is looked up **only at entry points** and **injected** downward. `buildPrint`,
`printBody` and `aggregateDay` take `{ release, window, admit }` as arguments and never look a
release up themselves (section 4).

- **Settlement entry points** (`settleDay`, `correctDay`, the settle route, the correction CLI and
  settlement `reproduce`) call `settlementReleaseFor(label)` once. That is the canonical lookup: it
  returns the release in effect whose `[effectiveFrom, effectiveUntil]` contains the label, and
  throws otherwise. A release after the first counts as in effect only once its `announcedAt` is set
  and it is not `withdrawn`. Every pre-E label gives v1, by design.
- **Indicative entry points** (the indicative builder and `reproduce --indicative`) select the
  release **by label**, through `indicativeReleaseFor(label)`, and never through the settlement
  lookup:
  - It takes the release registered **immediately after** the last release with
    `effectiveFrom ≤ label`, in registry order. It ignores which release is currently in effect and
    whether `announcedAt` or `effectiveUntil` are set.
  - It returns that successor only if the successor is v2.0.0 (the only release with an indicative
    admission policy), `2026-11-20 ≤ label < v2.effectiveFrom`, and the successor is **not
    `withdrawn`**. Otherwise it returns none.
  - **Withdrawal ends the series.** Each registry entry has a `withdrawn` flag, false by default and
    set only by a withdrawal notice. A withdrawn release is never in effect, and
    `indicativeReleaseFor` returns none for it, so no further indicative prints are built. Prints
    already published stay published, frozen and labelled indicative. `reproduce --indicative`
    checks them against `indicativeReleaseFor(label, { includeWithdrawn: true })`, so they still
    reproduce.
  - So for every label up to E−1 it is **v2's ET definition, explicitly**. The answer depends only
    on the label and the registry, and is the same in step 1, step 2 and after v2 takes effect. That
    matters for E−1: its print freezes at its cutoff, about 30 minutes after v2 takes effect
    (2027-01-01T05:30Z), when v2 is no longer "upcoming". A role-based lookup would skip it.
    `indicativeReleaseFor('2026-12-31')` is still v2.
  - Reproducing uses the release **recorded in the indicative print** (`methodologyOf`). The check
    fails unless that equals `indicativeReleaseFor(label)`.

  Neither path calls `settlementReleaseFor`. If they did, they would get v1 and build a UTC day.

Tests (section 8, item 4):

- A property test over labels E−3 to E+3 through every settlement path asserts that the recorded
  release is v1 if and only if the label is ≤ E−1. A v1 print for a label ≥ E is refused by every
  route (`?date=`, the correction CLI, reproduce).
- For one pre-E label (`2026-12-15`), the settlement print and the indicative print both exist, have
  distinct windows (`[2026-12-15T00:00Z, 2026-12-16T00:00Z)` under v1 and
  `[2026-12-15T05:00Z, 2026-12-16T05:00Z)` under v2), live at different keys, and each reproduces
  `MATCH` under its own path.

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

**The rollback floor is the step-2 deployment, and it must be live before `E 00:00Z`
(`2027-01-01T00:00Z`).** That is the first production deployment with the cutover windows in force,
`dayAt`, both print schemas (`adi.daily-print/1` and `/2`), the v2 key layout and isolated history.
From then on, no rollback target may predate it. A step-1 deployment is also too old, because its
registry has v2 not in effect. Any postponement advances the floor again. This is written into
Operations, next to the existing adapter and correction floors.

Why it matters: an older deployment knows only v1. At `2027-01-02T00:30Z` its settle cron would
treat "UTC yesterday", 2027-01-01, as a v1 day and write a v1 UTC print for it. Two defences, both
tested:

1. **Separate keys.** v2 settlement prints live at `prints/et/{date}/r{n}.json`. v1 prints keep
   `prints/{date}/r{n}.json`. A stale v1 settle for label E writes `prints/2027-01-01/r1.json`. It
   can never occupy, block or overwrite the v2 print's key, and v2 code never serves it.
2. **Misfiled-print detection.** v2 code treats any object at `prints/{date}/…` with `date ≥ E` (E
   read from the registry) as a misfiled stale write. The day view and the settle run report it as a
   `misfiled_print` problem, and the monitor alerts on that. The real print is unaffected.
3. **Isolated history.** v2 days' history is its own object, `prints/et/history.json`, which only v2
   code writes. `prints/history.json` stays v1's and is the only one a stale deployment can touch.
   **Reads filter by canonical key, so nothing waits for repair:** `/api/v1/history` takes labels ≤
   E−1 only from the v1 object and labels ≥ E only from the v2 object, and drops any entry outside
   its object's range. A stale entry for label ≥ E in the v1 object is never served, even before the
   next settle runs.
4. **Canonical correction reads.** `readCorrectionPrints` accepts `prints/{date}/r{n}` only for
   `date ≤ E−1` and `prints/et/{date}/r{n}` only for `date ≥ E`. Anything else is reported as
   `misfiled_print` and never listed on `/incidents`.

Tests (section 8, item 5) run a stale v1 settle, history update and correction against the same
`FileStore` archive, before and after the v2 settle. They assert, **immediately after the stale
write and before any repair**, that the v2 print, `/api/v1/days`, `/api/v1/history` and `/incidents`
are unchanged, and that `misfiled_print` is reported.

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
  `already_settled` (history repaired) or `failed` with the reason. When the list is empty it
  returns `nothing_due` with status 200. That outcome is new: today's default always targets UTC
  yesterday, which has passed its cutoff when the crons run. An **explicit** `?date=` whose cutoff
  has not passed still returns 409, as today.
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
- Indicative prints are **never** attested here (section 4). The only non-settlement files on the
  branch are the one-off gap pin `transition/{v2.effectiveFrom}.json` (D8, derived from the
  activated cutover) and the notice readback `notices/2.0.0.readback.json` (section 2), each written
  by its own job.

### Monitor (`lexabu/personal-configs` `scripts/adi-monitor.sh`)

Clock maths leaves the shell. Every 5-minute tick:

- **Heartbeat:** reads `lastRound.fetchedAt` from `/api/v1/current`. That field is always present,
  including during the transition interval (section 5), so the stall check never reads a missing day
  as a stall. A **null** `lastRound` (no round ever stored, as on a fresh preview store) is reported
  as "no data yet", not as a stall.
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
coverage, `printBody`). That code no longer looks anything up for itself. The caller injects three
things: the **release** (from `settlementReleaseFor` or `indicativeReleaseFor`), its
**`DayWindow`**, and the **admission predicate**. The two series differ in all three, and in nothing
else:

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
v1 print lists **every** receipt of its UTC day, valid and invalid, as
`(roundId, receiptHash, status)`, and is attested.

**Which v1 revision is the reference.** For each of v1 days D and D+1, the reference is the **latest
revision for which `verify-attestation` returns `MATCH`**: the print matches its attestation, and
the proof reaches a Bitcoin block before that revision's cutoff. Receipts are final after admission,
so every revision of a day lists the same receipts. The check asserts this too: if two verified
revisions of one day list different `(roundId, receiptHash)` sets, the result is `MISMATCH`. A day
with no verified revision yet makes the result `PENDING`.

**The comparison.** Both sides are sets of `(roundId, receiptHash)` pairs, **invalid receipts
included**:

- **reference:** the pairs of the two reference v1 prints whose slot is in D's window;
- **indicative:** the pairs the indicative print lists (it lists every in-window receipt, valid or
  invalid, and foreign ones too, as settlement prints do).

The two sets must be equal. Nothing may be omitted and nothing added. `reproduce --indicative D`
also rebuilds the print from those receipts. Outcomes, each with its own exit code:

| Outcome    | Exit | Meaning                                                                                                                                                                                                                                    |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MATCH`    | 0    | Rebuild matches and the sets are equal against verified v1 references.                                                                                                                                                                     |
| `MISMATCH` | 1    | Rebuild differs, sets differ, or verified revisions of one v1 day disagree.                                                                                                                                                                |
| `PENDING`  | 4    | Rebuild matches, but a reference is not yet verified. Either a v1 reference is not attested or its proof is pending (no set comparison has run yet), or, for E−1 only, the 228 covered slots are equal and the gap pin's proof is pending. |
| `PARTIAL`  | 5    | E−1 only: the 228 v1-covered slots are equal both ways, and the gap pin is absent. The gap receipts are listed as unpinned.                                                                                                                |

The attest workflow runs this for each indicative day once **its** v1 references verify. That is
both UTC days D and D+1 for every day up to E−2, and **only UTC day E−1 for E−1**, through the
explicit E−1 path below. The workflow never waits for a second reference, because none exists for
E−1. The run fails on `MISMATCH`. `PENDING` and `PARTIAL` are reported in the run summary, not as
failures. Like settlement days, indicative days are checked only while they are inside the run's
7-day reconcile window. The workflow writes no indicative attestation files.

**A missed pin cutoff is a `MISMATCH`, and operators should expect it to fail runs for a week.** If
the gap pin's proof first reaches a block after its cutoff (gap end + 24 h, `2027-01-02T05:00Z`),
E−1 is `MISMATCH` (step 4 below). That fails every attest run whose 7-day window still contains
2026-12-31: the runs of 2027-01-01 to 2027-01-07. From 2027-01-08, E−1 has left the window and runs
pass again. Nothing is rewritten to make them pass. The operator logs an incident saying the gap
slots of the indicative series have no timely external pin. This affects no settlement print.

**E−1 has its own branch.** The last indicative day (2026-12-31 ET) has **only one** v1 reference.
Its window `[2026-12-31T05:00Z, 2027-01-01T05:00Z)` spans v1 UTC day 2026-12-31 (228 slots) and the
gap `[2027-01-01T00:00Z, 05:00Z)` (60 slots). The gap's partition, 2027-01-01, has no v1 print. The
branch is chosen from the registry, not from a constant: the label is `v2.effectiveFrom − 1` (the
last label `indicativeReleaseFor` maps to v2), and the gap is the transition interval of the
activated cutover. `reproduce --indicative` for that label runs, in this order, and stops at the
first outcome:

1. **Rebuild** the print from the archive. If it differs from the published print, the result is
   `MISMATCH` (exit 1).
2. **Verify the single v1 reference** (UTC day E−1), as above. If it is not yet verified, the result
   is `PENDING` (exit 4). If its verified revisions disagree, the result is `MISMATCH` (exit 1).
3. **Compare the 228 covered slots both ways, before looking at the pin.** The reference pairs of
   UTC E−1 inside the window must equal the indicative pairs in those slots. Any difference gives
   `MISMATCH` (exit 1). So a missing or pending pin can never hide a mismatch in the covered part.
4. **Then consider the pin** (D8), at its derived path:
   - absent: `PARTIAL` (exit 5);
   - present, but its window differs from the derived transition interval, its bytes differ from the
     first-committed bytes, or its proof is invalid or reaches a block after the pin's cutoff (gap
     end + 24 h): `MISMATCH` (exit 1);
   - present with a valid but pending proof: `PENDING` (exit 4). The covered part has already been
     compared equal in step 3, so this `PENDING` never hides a mismatch;
   - present and verified: go to step 5.
5. **Compare the 60 gap slots both ways** against the pin. With step 3 that is the full 288-slot
   comparison. Equal gives `MATCH` (exit 0). Any difference gives `MISMATCH` (exit 1).

**D8, the gap pin (opt-in, recommended, and we will do it).** It is cheap: one file and one stamp,
and nothing in it is a constant. It is written only once a cutover is **activated**, meaning step 2
is live, so v1 has an `effectiveUntil` and v2 an `announcedAt`. Its name and window are derived from
that activated cutover:

- path: `transition/{v2.effectiveFrom}.json`;
- window: `[end of v1's last day, start of v2's first day)`, computed by `dayWindow` from the two
  releases.

For this cutover the path is `transition/2027-01-01.json` and the window is
`[2027-01-01T00:00Z, 05:00Z)`. At the first attest run after the transition interval has ended and
E−1's indicative print has frozen (its cutoff), the workflow writes the window and its sorted
`(roundId, receiptHash, status)` list, read from the public API. It stamps the file under the same
rules as a print: write-once, proof committed beside it, cutoff = gap end + 24 h.
`verify-attestation` ignores `transition/`. If the cutover is postponed, the derived path and window
move with it, and no file is ever written for a superseded date. The notice states that the gap is
pinned only this way, and only after the fact.

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
	/** When it takes effect: 00:00Z of `effectiveFrom` for v2 (v1 rule 4); its first day may start later. */
	effectiveAt: string;
	announcedAt: string | null; // N, from the readback record
	announcedProofAt: string | null; // B, the readback proof's block time
	withdrawn: boolean;
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
  `readCorrectionPrints` lists both key prefixes, filtered by canonical key (section 2).
- **Standing.** Frozen `/1` prints have no `standing` field, and none is added: that would change
  their hashed bytes. Standing is derived in one function, `standingOf(print)`:
  - a `/1` print is `'settlement'`, inferred **only after** it validates as `/1` (no `/1` print has
    ever been anything else, and the indicative series never writes `/1`);
  - a `/2` print must carry `standing` explicitly, and the schema refuses one without it.

  The API exposes the result in the **response envelope**, beside the print and outside it:
  `{ date, status, standing, window, print, revisions }`. So `/1` bytes are untouched and every
  client still sees a standing. `window` is likewise derived for `/1` prints (the UTC day) and read
  from `/2` prints.

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
  states `methodologyVersion`, `standing` and `window` (in the envelope, see Standing). The
  unsettled 404 body also states `window`, `settlesAt` and `publishBy`.
- **`/api/v1/days/{date}?parameterHash=<h>`**, for contracts that pin a hash. If the release that
  owns the label has a different hash, the response is a machine-readable **404**:

  ```json
  {
  	"problem": "parameter_hash_mismatch",
  	"date": "2027-01-01",
  	"expected": "<h, as requested>",
  	"actual": "<the hash of the release owning the label>",
  	"release": {
  		"version": "2.0.0",
  		"parameterHash": "<v2 hash>",
  		"effectiveFrom": "2027-01-01",
  		"effectiveUntil": null
  	}
  }
  ```

  No print is served in that case. A matching hash behaves as without the parameter.

- `/api/v1/current` (the response is a union on `status`):
  - `provisional`: today's settlement day, as now, plus `window`.
  - **`transition`**:
    `{ status: 'transition', asOf, previousDay: {date, window, settlesAt, publishBy}, nextDay: {date, window}, lastRound }`,
    with no value, coverage or slots.
  - **The heartbeat (`asOf`, `lastRound`) is outside the day block and present in both shapes.**
- `/api/v1/history`: entries gain `methodologyVersion`, `standing` and `window`. They are read from
  the two isolated history objects, filtered by canonical key (section 2). The default `to` is the
  latest day whose cutoff has passed.
- `/api/v1/methodology`: during the notice period adds
  `upcoming: { version, parameterHash, effectiveFrom, effectiveAt, announcedAt }`. During the
  transition interval it reports v2 as the release in effect (since 00:00Z), with no settlement day
  yet.
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
>   archived, and shown only in the indicative series. No v1 attestation covers them. Their receipt
>   list is pinned once, after the fact, by a timestamped file `transition/2027-01-01.json` on the
>   attestations branch.
> - **When it takes effect.** As v1 rule 4 requires, v2.0.0 takes effect at **00:00Z of a UTC day,
>   2027-01-01T00:00Z**, at least 30 days after this notice. Its first settlement day, ET day
>   2027-01-01, starts at 05:00Z (00:00 EST). No rule is amended.
> - **Rules for v2 days.** The settlement rules become version-scoped. v1.0.0 days keep the v1 rules
>   word for word. v2.0.0 days follow the v2 rules published with this notice, rules 1 to 8:
>   - deadlines are durations from the day's end (cutoff +30 min, publication +90 min, corrections
>     until cutoff +24 h);
>   - a `final` day may miss 13, 14 or 15 rounds (276-, 288- and 300-slot days);
>   - later versions take effect at 00:00 ET of a day. Admission stays strict: a settlement day
>     counts only rounds collected under exactly its own version and parameter hash. Only the panel
>     totals (ADI and ADI-GS) are settlement values; per-airport and hourly figures are
>     informational.
> - **Indicative series.** Until then, an indicative ET series, computed under v2 from the same
>   archived receipts, is at `/api/v1/indicative/…`, labelled "ADI (ET, indicative)". It is never a
>   settlement value. Its admission policy accepts receipts collected under v1.0.0 or v2.0.0 and is
>   stated in every indicative print.
> - **For exchanges and contract writers.** Pin the `parameterHash` (and version) in contract rules,
>   and request prints with `?parameterHash=`. A pinned hash that does not own the requested day
>   returns a machine-readable `parameter_hash_mismatch` 404 naming both hashes and the owning
>   release. **Contract rules should name a fallback for that outcome**, as they would for a source
>   that is unavailable. Do not write multi-day aggregates (weekly, monthly) that span 2026-12-31
>   and 2027-01-01: they would mix a UTC day, the gap and an ET day. No v1 print is changed or
>   corrected. Corrections are never used to apply v2 to past days (rule 8).
> - **Postponement or withdrawal.** Either is announced on this log **no later than
>   2026-12-18T00:00Z**, 14 days before v2 takes effect. After that, 2027-01-01 is fixed. A
>   postponed v2 gets a new effective day at least 30 days after the postponement notice (a fresh 30
>   days). A withdrawn v2 leaves v1 in effect with no end date and ends the indicative series. Its
>   published indicative prints stay, labelled indicative. Either way, no day is ever printed under
>   two methodologies, and older deployments that carry the superseded date are retired from
>   rollback.
> - **Effective-date record.** This entry has been public since `<N>`, the time of the successful
>   public readback of this notice (readback run `<id>`). The readback is recorded and timestamped
>   in `notices/2.0.0.readback.json` on the attestations branch, and its proof's Bitcoin block time
>   is `<B>`. These values are added by the follow-up registry change.
>
> Discussion: issue #<n>.

### Methodology changes (`docs/methodology.md`)

- A new **"Version history"** section:
  - **v2.0.0, effective ET day 2027-01-01, announced `<N>`.** Day boundary UTC → America/New_York.
    Slots per day 288 → 276/288/300. Thresholds as percentages of the day's slots. Deadlines
    unchanged as durations. Takes effect at 2027-01-01T00:00Z under v1 rule 4, with the first
    settlement day starting at 05:00Z. Settlement values clarified. Parameter hash `<v2 hash>`.
  - **v1.0.0, UTC days 2026-11-17 to 2026-12-31.** As published.
- **Version-scoped settlement rules.** "Settlement rules" opens with: "A day is governed by the
  rules of the methodology version that owns it (`/api/v1/days/{date}` states the version)." Then
  come two normative blocks:
  - **"Settlement rules, v2.0.0 (ET days from 2027-01-01)"**: all eight rules below, in order.
  - **"Settlement rules, v1.0.0 (UTC days 2026-11-17 to 2026-12-31)"**: an annex that holds today's
    rules 1 to 8 **verbatim in their final wording**: as on `main`, with no "PROVISIONAL, pending
    owner decision" markers, because the owner made those values final. That includes "D+1 01:30Z",
    "D+2 00:30Z", "up to 14 can be missing" and rule 4's "takes effect only at 00:00Z of a UTC day …
    at least 30 days before". A test fails the build if "PROVISIONAL" appears anywhere in
    `docs/methodology.md`. The annex is never edited again, because v1 prints keep citing it.
- The DST annex below is copied in as normative for v2.

#### Settlement rules, v2.0.0 (text to publish)

These rules decide what a contract that cites a v2.0.0 day settles on. "Rule n" below always means
rule n of this list. Where a rule and the rest of the methodology disagree, the rule wins.

1. **Only `final` prints are settlement-eligible.** A `degraded` print and a `suspended` print are
   published, hashed and archived like any other, but neither is a settlement value. A `degraded`
   value is shown for information only. The settlement values of a `final` print are its panel
   totals, `value` (ADI) and `groundStopValue` (ADI-GS). Per-airport minutes and the hourly series
   are informational.
2. **The print is revision 1 of `GET /api/v1/days/{date}`**, which must have
   `standing: 'settlement'`, unless a correction replaces it under rule 8. Nothing else (the running
   value, `/api/v1/history`, the indicative series, the site) is a settlement value.
3. **Gaps in the data can move the value either way, by a bounded amount.** A slot with no valid
   round carries the last observed state for at most 2 slots (10 minutes), then contributes 0. A
   carried slot can overcount or undercount by at most 10 airport-minutes per airport per gap. A
   `missing` slot only ever undercounts. A `final` day needs `valid × 100 ≥ 95 × slots`, so it can
   lack at most **13** valid rounds on a 276-slot day, **14** on a 288-slot day and **15** on a
   300-slot day (see the DST annex). Nothing is estimated or backfilled.
4. **One methodology per day.** A new methodology version takes effect only at 00:00
   America/New_York of a day, and is announced on the incident log at least 30 days before. The
   announcement records the instant it became public. A postponement or withdrawal is announced at
   least 14 days before the announced effective instant, and a new effective day needs a fresh 30
   days. Each version stays in the code with the days it governs. A day is computed only under the
   version that owns it, and a round counts only if it records exactly that version and parameter
   hash. Otherwise the day prints `suspended` with the reason `mixed methodology` and the number of
   rounds found under each other version. Such rounds are not counted in the running value either,
   and `/api/v1/current` lists them in `foreignMethodologies`. (v2.0.0 itself took effect at
   2027-01-01T00:00Z under v1 rule 4. The instants from then to 05:00Z, the start of its first
   settlement day, belong to no settlement day.)
5. **Feed data the index cannot read never settles.** Redirects are not followed, so a moved feed
   makes rounds invalid (`network_error` or `http_status`). A changed GS or GDP list fails the round
   (`parse_error`), and so does an element at the root the feed has never carried or a
   counted-program block that does not hold exactly its list (`unrecognized_structure`). An invalid
   round counts as not received: it only lowers coverage, and the coverage thresholds alone decide
   the status. A few rejected rounds therefore leave a day `final` (up to 13, 14 or 15 by the day's
   slot count, rule 3), and more make it `degraded` or `suspended`. Restoring collection is a
   source-adapter fix or a methodology change, and neither ever applies to a day already printed.
6. **New list types are recorded and flagged, never counted.** A `Delay_type` block whose name v2
   does not count, holding a list v2 does not know, is recorded in the receipt as `unrecognized`.
   The round stays valid, and any such list seen in today's valid rounds is listed in
   `unrecognizedLists` in `/api/v1/current` and on `/status`. A block named for a counted program
   holding anything but exactly its own list makes the round invalid under rule 5. If the FAA starts
   reporting ground stops or ground delay programs under a new name and list, v2 undercounts until a
   methodology change counts it.
7. **Publication deadline and retries.** The print for day D is due **90 minutes after D ends** (D+1
   01:30 ET, see the DST annex). The settle job runs at the settlement cutoff (30 minutes after D
   ends, D+1 00:30 ET) and retries 15 and 30 minutes later. A run that finds no print reads every
   in-window receipt of the day and checks it against its `receiptHash`. A receipt that cannot be
   read or verified stops that run without printing anything, and the next run tries again. A run
   that finds a print already stored returns it and repairs the history index. If no print exists at
   the deadline, the operator opens an incident. **A late print is still the print.**
8. **Corrections.** Only the operator issues a correction print (revision 2 or later), rebuilt from
   the day's stored receipts under the version the superseded print records. A correction for day D
   may be issued until **24 hours after D's settlement cutoff** (`settlesAt` + 24 h). After that the
   print stands, unless the operator issues a correction with a written justification, recorded in
   `windowOverride`. Every correction is listed on the incident log, and every revision stays
   published. A correction never applies a later methodology to a past day.

v1 rule 4 governs this announcement and the effective instant. v1 rule 8 applies only as a
prohibition: no v1 day is reprinted under v2.

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
   `[E 00:00Z, E 05:00Z)` and nothing else. Property test over labels E−3 to E+3 through every
   settlement entry point (`settleDay`, `correctDay`, the settle route with `?date` and default, the
   correction CLI, settlement `reproduce`): the release is v1 if and only if the label is ≤ E−1, and
   a v1 print for a label ≥ E is impossible on every path. `printBody` and `aggregateDay` have no
   registry import (a lint rule enforces it), so they can only use the release they are given. The
   indicative builder uses `indicativeReleaseFor(label)`, `reproduce --indicative` checks the
   print's recorded release against it, and neither calls the settlement lookup. For `2026-12-15`,
   the settlement and indicative prints have the distinct windows given in section 2, live at
   different keys and each `MATCH`.
5. **Rollback and stale writes:** on one `FileStore`, a stale v1 settle (with its history update)
   and a stale v1 correction for label E, run before and after the v2 settle. **Immediately after
   each stale write**, with no repair run, the v2 print, `/api/v1/days`, `/api/v1/history` and
   `/incidents` are unchanged, and `misfiled_print` is reported. The converse also holds: v2 code
   never writes under `prints/{date}` or `prints/history.json` for labels ≥ E. E is taken from the
   registry: a test registry with a different `effectiveUntil` moves the detection boundary with it.

   **Two-step publication:** with `announcedAt: null`, v2 is never in effect (no `effectiveUntil`,
   no transition, collector tags v1), and the indicative series still works, bounded by
   `v2.effectiveFrom − 1` through `indicativeReleaseFor`. A failed `notice-readback` run writes
   nothing. The successful run writes the single record once, with N = max(`Date` headers,
   `run_started_at`). Step-2 CI accepts it only if its bytes are as first committed, its proof
   verifies, and `effectiveAt(v2) ≥ max(N, B) + 30 d`, including a case where B < N and one where
   B > N. A `withdrawn` v2 is never in effect, and `indicativeReleaseFor` returns none for it, while
   its already-published indicative prints still reproduce. No gap pin is written before the cutover
   is activated. A test registry with a postponed `effectiveFrom` moves the pin's path and window
   with it. Step 2 is refused by the registry test unless `start(E) ≥ announcedAt + 30 d`. A
   postponement entry after the 14-day close is refused. A rollback-floor check rejects deployments
   older than the latest cutover registry change.

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
   `standingOf` infers `'settlement'` for a `/1` print only after `/1` validation, and the envelope
   carries it with the `/1` bytes unchanged. `?parameterHash=` gives the `parameter_hash_mismatch`
   404 (expected, actual, owning release) for a wrong hash on each side of the cutover, and the
   normal response for the right one.
10. **Monitor dry runs** (`--now`): `2027-01-01T00:05Z` (transition, heartbeat fresh, no false
    stall); `2027-01-01T01:40Z` (v1 2026-12-31 alert path); `2027-01-01T05:05Z` (first v2 slot,
    nothing due); `2027-01-02T06:40Z` (2027-01-01 alert path); `2027-03-14T06:40Z` (EST alert);
    `2027-03-15T05:40Z` (EDT alert); an open alert kept after it leaves the window; a
    `misfiled_print` alert; a null `lastRound` reported as "no data yet" and not as a stall. Silent
    before each `publishBy + 10 min`.
11. **Attest workflow:** UTC targeting on the legacy trigger and ET targeting on the new ones; a
    "not yet published" skip; an overdue failure; delayed starts; duplicate runs; both DST nights
    and the cutover.
12. **Indicative proof:**
    - the both-ways `(roundId, receiptHash)` set check passes, with invalid receipts included;
    - it fails with one receipt omitted, one extra, one invalid receipt dropped, and one hash
      changed;
    - the reference is the latest `verify-attestation` `MATCH` revision, and two verified revisions
      that disagree give `MISMATCH`;
    - `PENDING` before the v1 references verify;
    - the E−1 branch, one test per exit: a rebuild difference gives 1; an unverified UTC E−1
      reference gives 4; a covered-slot difference gives 1 **with the pin absent and with it
      pending** (a pin never masks a covered mismatch); no pin gives 5, with exactly the 60 gap
      slots listed; a pending pin gives 4 (after the covered slots compared equal); a late or
      invalid pin, a wrong window or rewritten pin bytes give 1; a verified pin with equal gap slots
      gives 0; an altered gap receipt gives 1;
    - the attest workflow checks E−1 with only UTC E−1 attested, and never waits for a second
      reference. With a late pin, the runs of 2027-01-01 to 2027-01-07 fail on E−1's `MISMATCH`, and
      the 2027-01-08 run passes;
    - **after activation**, with v2 in effect: at `2027-01-01T05:30Z` the settle run still builds
      and freezes the E−1 indicative print, because `indicativeReleaseFor('2026-12-31')` is v2. The
      05:45Z attest run writes and stamps `transition/2027-01-01.json`. `indicativeReleaseFor` gives
      v2 for every label from 2026-11-20 to E−1 in step 1, in step 2 and after E, and none for
      labels ≥ E.
13. **v1 end-to-end fixtures** (section 6): `MATCH` with every pinned byte and deadline.
14. **API and UI at both boundaries** (`E 00:00Z` and `E 05:00Z`): `/current` switches `provisional`
    → `transition` → `provisional`; `/days`, `/methodology` and `/` render each state; ET, UTC and
    local rendering; DST-day charts.
15. **After cutover** (checklist): reproduce 2026-12-31 and 2027-01-01, both `MATCH`; then remove
    the v1 crons and the 01:45Z attest run.

## Decisions for review

| #   | Decision                  | Recommendation                                                                                                       |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | Effective date            | Target 2027-01-01. Lower bound: start ≥ N + 30 d, with N recorded in step 2. Postponable until E − 14 d, then fixed. |
| D2  | 5 h cutover gap           | Accept and state it, with no settlement day for those instants.                                                      |
| D3  | Admission                 | Strict and frozen for settlement. A hashed policy for indicative only.                                               |
| D4  | Indicative series         | Separate endpoints and keys, ET-indicative labels, `standing` in the hash, no own attestation, both-ways proof.      |
| D5  | Thresholds                | Percentages of the day's slots.                                                                                      |
| D6  | Values on 23/25-hour days | Not normalized. Stated.                                                                                              |
| D7  | Settlement values         | Panel totals only (ADI, ADI-GS). Breakdowns informational.                                                           |
| D8  | Gap pin                   | Do it: a one-off timestamped `transition/2027-01-01.json` lets E−1's indicative proof reach `MATCH`.                 |

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

## Final confirm (Opus) dispositions

| Id  | Disposition                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O15 | Done. No rule-4 amendment. v2 takes effect at 2027-01-01T00:00Z, the end of v1's last day, as v1 rule 4 requires, and its first settlement day starts at 05:00Z. Gap rounds are tagged v2. All amendment text is removed, and the notice says no rule is amended. The v1 annex carries the final wording from `main`, with no PROVISIONAL markers, and a test enforces that (sections 2, 7). |
| O16 | Done. One readback record. A failed run writes nothing and is simply rerun. N = max(`Date` headers, `run_started_at`), and B is the proof's block time. The bound is `effectiveAt ≥ max(N, B) + 30 d`, with no B ≥ N check. The readback revisions, the cross-revision max and the CI walk are deleted. Step-2 CI verifies the one record and the inequality (section 2, test 5).            |
| O17 | Done. `PARTIAL_PENDING` (exit 6) is merged into `PENDING` (exit 4). Because the covered slots are compared first, `PENDING` never hides a mismatch (section 4, test 12).                                                                                                                                                                                                                     |
| O18 | Done. A `withdrawn` registry flag. `indicativeReleaseFor` returns none for a withdrawn release, ending the series. Published indicative prints stay and still reproduce (sections 2, 7, test 5).                                                                                                                                                                                             |
| O19 | Done. A missed pin cutoff makes E−1 a `MISMATCH`, which fails the attest runs of 2027-01-01 to 2027-01-07 until E−1 leaves the 7-day window. Operators should expect it, log an incident and rewrite nothing (section 4, test 12).                                                                                                                                                           |

The round 2 to 5 entries below about the readback revision chain (S6), the rule-4 amendment (S14,
S6) and `PARTIAL_PENDING` (S5) are superseded by O15 to O17.

## Round 5 review dispositions

| Id  | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6  | Done. For revision k, `N_k = max(own run_started_at, own Date headers, N of every prior revision)`, stored with the priors it took the maximum over, so N never decreases. Step-2 CI recomputes every revision's N and requires the cited revision's N ≥ every prior N, `announcedAt` = that N, and a verified proof with block time ≥ that N. Test: a first `Date` of 12:20Z and a retry `Date` of 12:15Z give N = 12:20Z (section 2, test 5). |

## Round 4 review dispositions

| Id  | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5  | Done. (a) The attest workflow has an explicit E−1 path that needs only UTC E−1 and never waits for a second reference. (b) The E−1 branch now runs: rebuild, then the v1 reference, then the 228 covered slots compared both ways (`MISMATCH` on any difference), and only then the pin. Exits: 0 `MATCH`, 1 `MISMATCH`, 4 `PENDING`, 5 `PARTIAL` (no pin), 6 `PARTIAL_PENDING` (pin proof pending) (section 4, test 12).                                                                |
| S6  | Done. Step 2 uses N only once its readback proof is verified (an existing block, header time ≥ N, committing to the first-committed bytes), and CI re-checks this. A rejected record is never overwritten; the next readback is `notices/2.0.0.readback.r2.json` (then `.r3`…), the first verified revision wins, N only moves later, and E is recomputed under the lower bound, with an incidents entry if it moves. The rollback floor is unaffected until step 2 deploys (section 2). |
| O12 | Done. `indicativeReleaseFor(label)` selects by label: the registered successor of the last release with `effectiveFrom ≤ label`, only if that is v2 and the label is before `v2.effectiveFrom`. It is independent of what is in effect, so E−1 still freezes and pins after activation. Tested at 2027-01-01T05:30Z and 05:45Z (sections 2, 4, tests 4, 5, 12).                                                                                                                          |

## Round 3 review dispositions

| Id  | Disposition                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S5  | Done. An explicit E−1 branch: verify the single v1 reference, then verify the gap pin (first-committed bytes, derived window, proof before its cutoff), then rerun the full both-ways comparison to `MATCH`. `PARTIAL` without the pin, `PENDING` while a proof is pending (section 4, test 12).                                                      |
| S6  | Done. N is the first successful public production readback, never Vercel `ready`. A `notice-readback` workflow records the run, the `Date` headers, `X-Deployed-Commit` and the body hashes in an OTS-stamped, write-once `notices/2.0.0.readback.json`. N is the later of `run_started_at` and the `Date` headers, and step 2 copies it (section 2). |
| S13 | Done. Entry points look up the release and inject `{release, window, admit}`. `printBody` and `aggregateDay` never look one up, enforced by a lint rule. Sections 2 and 4 and test 4 now agree.                                                                                                                                                       |
| S14 | Done. All eight v2 rules are published in order (1 to 8), with cross-references checked. Rule 2 now points at rule 8 for corrections; the earlier list had been renumbered by the formatter (section 7).                                                                                                                                              |
| O12 | Done. The indicative bound comes from `upcomingRelease().effectiveFrom`, so it works in step 1 when v1 has no `effectiveUntil`. The gap pin's path and window derive from the activated cutover, and none is written before activation or for a superseded date (sections 2, 4).                                                                      |
| S7  | Done. PlaneTrack quoted verbatim, "Departures are counted by scheduled day (UTC).", and marked verified (section 0).                                                                                                                                                                                                                                  |

## Round 2 review dispositions

| Id       | Disposition                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S13      | Done. `settlementReleaseFor` stays canonical; `INDICATIVE_RELEASE` selects v2 explicitly for the builder and `reproduce --indicative`; test of distinct windows for `2026-12-15` (sections 2, 4, test 4).                                             |
| S14      | Done. Version-scoped rules: v2 restates rules 3, 4, 5, 7 and 8 (deadlines as durations, 13/14/15 missing rounds); v1's rules 1 to 8 kept verbatim in their own annex (section 7).                                                                     |
| S3       | Done. Isolated v2 history object; history and correction reads filtered by canonical key, so stale writes are never served even before repair; tests immediately after each stale write (section 2, test 5).                                          |
| S5 / O13 | Done. Reference = latest `verify-attestation` `MATCH` revision per v1 day, with disagreeing verified revisions a `MISMATCH`; `(roundId, receiptHash)` sets on both sides, invalid included; distinct `PARTIAL` (exit 5) for E−1 (section 4).          |
| O14      | Done, opt-in, and we will do it (D8): one stamped `transition/2027-01-01.json`, after which E−1 can reach `MATCH` (section 4).                                                                                                                        |
| S6       | Done. Two-step publication: notice deploy with `announcedAt: null` (v2 not in effect), readback of the immutable Vercel `ready` timestamp, step-2 registry deploy; the three conditions under which the amendment authorizes the cutover (section 2). |
| S7       | Done as far as we can. PlaneTrack is marked verified on Sol's authority, as a UTC-day counterexample. It still returns 403 to our fetchers and has no archive, so the verbatim quote is left for Sol rather than invented (section 0).                |
| S11      | Done. `standingOf`: `/1` inferred `'settlement'` after `/1` validation, `/2` explicit; standing and window in the response envelope; `/1` bytes unchanged (section 5, test 9).                                                                        |
| O10      | Done. Postponement closes 14 days before E (`2026-12-18T05:00Z`); fresh 30 days for a new date; each change advances the rollback floor; the "fixed once N is recorded" conflict removed (sections 2, 7, D1).                                         |
| O11      | Done. `?parameterHash=` gives a `parameter_hash_mismatch` 404 with expected, actual and the owning release; the notice asks contract writers for a fallback (sections 5, 7, test 9).                                                                  |
| O12      | Done. E derived from the registry everywhere, misfiled detection included; test with a moved `effectiveUntil` (section 2, test 5).                                                                                                                    |
| Devin D1 | Done. Aggregation takes the release, `DayWindow` and admission predicate injected; "the only difference" wording replaced (section 4).                                                                                                                |
| Devin D2 | Done. `nothing_due` is described as new; explicit `?date` before its cutoff still 409 (section 3).                                                                                                                                                    |
| Devin D3 | Done. Null `lastRound` is "no data yet", not a stall (section 3, test 10).                                                                                                                                                                            |

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
