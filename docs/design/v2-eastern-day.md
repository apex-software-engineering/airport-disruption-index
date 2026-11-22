# Design: methodology v2.0.0, the US Eastern day

Status: **draft for review** (phase 1, no code). Refs #11.

Methodology v2.0.0 changes one thing: the day a print covers. v1 counts the UTC day. v2 counts the
civil day in **America/New_York** (US Eastern, "ET"). The slot grid, the source, the panel, the
observation checks, the carry ladder and the coverage percentages are unchanged. Every v1 print
keeps settling, reproducing and verifying under v1 forever.

Decisions this review should settle are marked **D1** to **D6** and collected at the end.

## 0. Why ET (primary sources)

The owner's rule was to keep UTC only if comparable indexes and Kalshi use it. Each claim below
cites the primary document and quotes the line it rests on. Anything that could not be opened is
marked **unverified** and is not relied on.

| Source                                                                                                                                                                     | What it says (verbatim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Bearing                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kalshi AIRPORTDELAY certification, [AIRPORTDELAY.pdf](https://assets.kalshi.com/regulatory/product-certifications/AIRPORTDELAY.pdf)                                        | "All times relating to <time period> and to the scheduling and operation of flights are interpreted in the local time of <airport> unless otherwise specified. The end of <time period> is defined as 11:59:59 PM local time at <airport> on the final day of the specified period." Also: "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET."                                                                                                                                                                                                              | Airport contracts use the airport-local day, not UTC, and expire at an ET wall-clock time.                                                                                                                                     |
| Kalshi FLIGHTJFK certification, [FLIGHTJFK.pdf](https://assets.kalshi.com/regulatory/product-certifications/FLIGHTJFK.pdf)                                                 | "The Last Trading Time will be 11:59 PM ET." "Expiration Date: The Expiration Date of the Contract shall be the sooner of the date of the first 10:00 AM ET following the release of the data for all of <date>, or one week after <date>." "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET."                                                                                                                                                                                                                                                             | The trading day ends at 11:59 PM ET. JFK is in ET, so this does not separate "local" from "ET".                                                                                                                                |
| Kalshi ORDDLY certification, [ORDDLY.pdf](https://assets.kalshi.com/regulatory/product-certifications/ORDDLY.pdf)                                                          | "Date: <date> refers to a calendar <date> specified by Kalshi." "Expiration time: The Expiration time of the initial Contract iteration shall be 10:00 AM ET."                                                                                                                                                                                                                                                                                                                                                                                                                       | Expires at 10:00 AM ET for a Central-time airport. The document does not say which zone `<date>` is in, so it is no evidence either way on the day boundary.                                                                   |
| Kalshi temperature certification (the PM's source for KXHIGH), [GLOBALTEMPERATURE.pdf](https://assets.kalshi.com/regulatory/product-certifications/GLOBALTEMPERATURE.pdf)  | "Expiration time: The Expiration time of the Contract shall be 10:00 AM ET." "The Last Trading Time will be one minute prior to the final time in <time period>."                                                                                                                                                                                                                                                                                                                                                                                                                    | 10:00 AM ET again. The PDF does not name KXHIGH or state the zone of `<time period>`, so the mapping to KXHIGH and its day zone are **unverified** here.                                                                       |
| Kalshi API, KXFLYCANCJFK markets, [markets?series_ticker=KXFLYCANCJFK](https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXFLYCANCJFK) (read 2026-11-21) | `rules_primary`: "If the percentage of scheduled passenger and cargo flights at John F. Kennedy International Airport (JFK/KJFK) that are cancelled during October 21, 2026 is at least 50%, then the market resolves to Yes." `rules_secondary`: "All dates and times relating to the scheduling and operation of flights are interpreted in the local time of John F. Kennedy International Airport (JFK/KJFK) unless otherwise specified." "Schedule baseline: The schedule baseline for this market is October 19, 2026 at 11:59:59 PM ET." `close_time`: `2026-10-22T14:00:00Z` | A live market: the day is the airport-local day, and it closes at 14:00Z, which is 10:00 AM EDT the next morning.                                                                                                              |
| FAA ATCSCC advisory time zone, [fly.faa.gov/ois/help/index.html](https://www.fly.faa.gov/ois/help/index.html)                                                              | **Unverified.** The page returned 404 on 2026-11-21 ("No static resource help/index.html"), and `/ois/` redirects to nasstatus.faa.gov.                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not relied on. In-repo fact instead: the feed we read stamps `Update_Time` in GMT (`Tue Nov 17 20:43:54 2026 GMT`, [sources.md](../sources.md)). That is how the FAA timestamps the feed. It does not define a settlement day. |
| BTS Technical Directive #17, time reporting, [bts.gov](https://www.bts.gov/topics/airlines-and-airports/number-17-technical-directive-time-reporting-effective-oct-1-2008) | **Unverified.** The page returned HTTP 403 to automated fetches on 2026-11-21.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not relied on.                                                                                                                                                                                                                 |

What this supports: every Kalshi airport document we could open defines the day in airport-local
time and states its deadlines in ET. None uses UTC. A 20-airport panel spans four zones (10 airports
in Eastern: ATL JFK CLT MCO MIA EWR BOS FLL LGA DTW; 4 Central: DFW ORD IAH MSP; 2 Mountain: DEN
PHX; 4 Pacific: LAX LAS SEA SFO), so it has no single local day. ET is the zone Kalshi already
writes its deadlines in, and it is the local zone of half the panel. That a multi-airport contract
"would be written on an ET day" is the PM's inference from these documents. No source states it.

## 1. Day definition

A v2 day `D` (a `YYYY-MM-DD` date in ET) is the half-open interval

`[D 00:00 America/New_York, D+1 00:00 America/New_York)`

It is computed from the IANA zone, not a fixed offset. ET is UTC−5 (EST) or UTC−4 (EDT), always a
whole number of hours, so **every ET midnight falls on a UTC hour boundary, and so on a 5-minute
slot boundary**. Round ids, slot starts and receipts are unchanged: a round still belongs to slot
`floor(fetchedAt, 5 min)` and is named by its UTC slot start (`2026-11-17T20:45Z`). Only the
grouping of slots into days changes.

| Day kind                             | Length | Slots | Hourly buckets | Max value (20 × minutes) |
| ------------------------------------ | ------ | ----- | -------------- | ------------------------ |
| Ordinary                             | 24 h   | 288   | 24             | 28,800                   |
| Spring forward (2nd Sunday of March) | 23 h   | 276   | 23             | 27,600                   |
| Fall back (1st Sunday of November)   | 25 h   | 300   | 25             | 30,000                   |

Hourly buckets stay UTC-hour-aligned (each ET hour is a UTC hour). On a fall-back day the local hour
01:00 occurs twice, as 01:00 EDT (05:00Z) and 01:00 EST (06:00Z). Buckets are keyed by their UTC
`hourStart`, so they never collide.

The value is a count of airport-minutes, so a 25-hour day can count more than a 24-hour day. That is
a level effect of two days a year. It is stated, not normalized, as Kalshi's airport contracts do
for their local days. The carry ladder restarts at each ET midnight, so slot 0 of ET day `D` never
carries from the last slot of `D−1`.

### Coverage thresholds scale as percentages

Coverage = valid rounds / **that day's** slot count. The thresholds stay `finalMinPercent: 95` and
`degradedMinPercent: 80` and are compared in integers, as in v1: `valid × 100 ≥ percent × slots`. No
rounding is involved. The smallest passing count is `ceil(percent × slots / 100)`:

| Slots | `final` needs (95%)                  | `degraded` needs (80%)               | Rounds a `final` day can miss |
| ----- | ------------------------------------ | ------------------------------------ | ----------------------------- |
| 276   | 95 × 276 = 26,220 → **263** (262.2↑) | 80 × 276 = 22,080 → **221** (220.8↑) | 13                            |
| 288   | 95 × 288 = 27,360 → **274** (273.6↑) | 80 × 288 = 23,040 → **231** (230.4↑) | 14                            |
| 300   | 95 × 300 = 28,500 → **285** (exact)  | 80 × 300 = 24,000 → **240** (exact)  | 15                            |

Why percentages, not fixed counts: a fixed 274 would ask a 276-slot day for 99.3% coverage (2 missed
rounds) and a 300-slot day for 91.3%. The rule's intent, the share of the day observed, would then
depend on the calendar. `coverage.percent` stays a display value, `round(valid / slots × 100, 2)`.
Status always comes from the integer comparison.

## 2. Cutover

### Effective date

Let `N` be the instant the notice is published: the production deploy that adds the incidents entry
(section 7). The effective day `E` is **the first ET date whose start (`E 00:00 ET`) is at or after
`N + 30 × 24 h`**.

**D1 (recommended): `E = 2027-01-01`**, if the notice is live by `2026-12-02T05:00Z` (00:00 EST on 2
December). A year boundary is easy to cite, and the margin absorbs a late merge. If the notice
misses that instant, E is recomputed by the rule above and the registry entry is changed before
merge. A registry test checks `E start ≥ N + 30 days` against the notice date.

Worked example (D1): v2's first instant is `2027-01-01T05:00Z` (00:00 EST).

### The last v1 print, and the hours in no settlement print

- **The last v1 print is UTC day `E−1`** (`2026-12-31`, `[2026-12-31T00:00Z, 2027-01-01T00:00Z)`).
  It settles at `2027-01-01T00:30Z` under v1, as today.
- **The first v2 print is ET day `E`** (`2027-01-01`, `[2027-01-01T05:00Z, 2027-01-02T05:00Z)`).
- **`[E 00:00Z, E 05:00Z)` (5 hours, 60 slots; 4 hours and 48 slots if E falls in EDT) is in no
  settlement print.** For D1 that is `2027-01-01T00:00Z` to `05:00Z`, which is 19:00 to 24:00 EST on
  31 December. Rounds are still collected and archived for those hours. They appear in the
  indicative v2 print for ET day `E−1` (section 4), which is never a settlement value.

A cleaner cutover does not exist. UTC and ET midnights never coincide, so any switch leaves either a
gap or an overlap of 4 to 5 hours. Alternatives considered:

| Option                                                              | Why rejected                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Last v1 day UTC `E`, first v2 day ET `E` (overlap)                  | 19 hours counted twice, and two settlement prints with the same date label `E`.                    |
| A one-off v1 "stub day" covering `[E 00:00Z, E 05:00Z)`             | A 60-slot day that no contract would reference, with its own coverage maths and a label collision. |
| A first v2 day that starts at `E 00:00Z` and runs to `E+1 00:00 ET` | A 29-hour day of its own kind, an exception in every rule and test, for 5 hours nobody settles on. |
| Wait for EDT (≥ 2027-03-15) to shrink the gap to 4 hours            | Delays the change 10 weeks to save 1 hour.                                                         |

**D2: accept the gap** (recommended). The announcement says so plainly (section 7).

### Which release a round is collected under

Each release gets an **effective instant**: the start of its first day under its own boundary (v1
`2026-11-17T00:00Z`; v2 `E 00:00 ET`). The collector tags a round with the release in effect at
`fetchedAt`. Gap rounds are therefore tagged v1. They belong to no v1 day, and they are still
accepted by v2 aggregation (next subsection).

### Receipt compatibility (replaces the strict "foreign methodology" test)

Today a day suspends if any round records a version or hash other than the day's (rule 4). Under
that rule v2 could not aggregate v1-collected receipts, so section 4 would be impossible and a
collector deployed one tick late would suspend day E.

A receipt depends only on a subset of the parameters: `source`, `panel`, `slotMinutes`,
`roundAssignment`, `quorum` and `observation`. Call these the **receipt parameters**. v1 and v2 have
identical receipt parameters. The rule becomes:

> A round counts in day D only if the release it records is known to this code **and** has the same
> receipt parameters as the release in effect on D. Any other round is foreign: it takes no slot,
> and the day prints `suspended` with the reason `mixed methodology`, as today.

This is derived from the registry, not declared, so no release can vouch for another by assertion.
The type system enforces it: `evaluateObservation` and `buildReceipt` take `ReceiptParameters` (the
subset) rather than `MethodologyParameters`, so a receipt cannot depend on a field outside the
subset without a compile error. A future v3 that changes a receipt parameter (the panel, say) gets
the strict behaviour back automatically.

**D3:** adopt receipt compatibility (recommended). The alternative keeps the strict rule for
settlement days and allows compatibility only for the indicative series. That is two code paths, and
the indicative series would no longer be "the same computation".

## 3. Settlement timing

Every v1 deadline is already a fixed duration after the day's end. v2 keeps the durations and
changes only where the day ends. All arithmetic is on instants, so no wall-clock time is ever
converted, and DST cannot shift a deadline.

| Deadline                           | Rule (unchanged)             | v1, day D   | v2, day D ending in EST | v2, day D ending in EDT |
| ---------------------------------- | ---------------------------- | ----------- | ----------------------- | ----------------------- |
| Day end                            | n/a                          | D+1 00:00Z  | D+1 05:00Z (00:00 EST)  | D+1 04:00Z (00:00 EDT)  |
| Last admission (last slot +60 s)   | end + 1 min                  | D+1 00:01Z  | D+1 05:01Z              | D+1 04:01Z              |
| Settlement cutoff (`settlesAt`)    | end + 30 min                 | D+1 00:30Z  | D+1 05:30Z (00:30 EST)  | D+1 04:30Z (00:30 EDT)  |
| Publication deadline (`publishBy`) | end + 90 min                 | D+1 01:30Z  | D+1 06:30Z (01:30 EST)  | D+1 05:30Z (01:30 EDT)  |
| Corrections window                 | cutoff + 24 h                | D+2 00:30Z  | D+2 05:30Z              | D+2 04:30Z              |
| Attestation cutoff, r1             | end + 24 h                   | D+2 00:00Z  | D+2 05:00Z              | D+2 04:00Z              |
| Attestation cutoff, correction     | `correction.issuedAt` + 48 h | (zone-free) | (zone-free)             | (zone-free)             |

US DST changes happen at 02:00 local, after every 00:30 and 01:30 deadline of that night, so the
cutoff and the deadline always read 00:30 and 01:30 ET. On a fall-back Sunday, 01:30 ET happens
twice. `end + 90 min` picks the first (EDT) one, which removes the ambiguity. The 24-hour windows
(corrections, r1 attestation) are durations. Across a DST weekend they read 23:30 or 01:30 ET on the
wall clock, by design: "24 hours after publication" stays exactly 24 hours.

The r1 attestation cutoff is currently coded as "D+2 00:00Z". It becomes `dayEnd(D) + 24 h`, which
gives exactly the same instant for every v1 day. So the formulas do not fork. Only the day window
does.

### Crons (Vercel cron and GitHub Actions run in UTC)

Settle: the route stops taking "UTC yesterday" as its default. It settles **every settlement day
whose cutoff has passed in the last 48 hours and that has no print**, oldest first. A run with
nothing due returns `200 {status: 'nothing_due'}` instead of `409`. The schedule covers both
offsets:

```json
{ "path": "/api/cron/settle", "schedule": "30,45 4,5 * * *" },
{ "path": "/api/cron/settle", "schedule": "0 5,6 * * *" }
```

In EDT the 04:30Z run settles, 04:45Z and 05:00Z retry, and the 05:30Z to 06:00Z runs find nothing.
In EST the first three runs find nothing, 05:30Z settles, and 05:45Z and 06:00Z retry. Either way
the last retry is 30 minutes before the deadline, the same margin as today. The v1 entries (`30 0`,
`45 0`, `0 1`) stay until the last v1 day (`E−1`) has printed at `E 00:30Z`, and are removed in a
follow-up PR after the cutover check (section 8).

Collect is unchanged (`*/5`).

Attest (`.github/workflows/attest.yml`): today it runs at `45 1 * * *`. It moves to `45 5,6 * * *`,
15 minutes after the EDT and EST publication deadlines. "Yesterday" is computed as the ET date
(`TZ=America/New_York date -d "$created -1 day"`), which at 05:45Z and 06:45Z is always the UTC date
minus one. The `01:45Z` run stays until `E−1` is attested. With the earlier run the window between
settlement and the first stamp shrinks from about 75 minutes to 15 to 75 minutes.

### Monitor (`lexabu/personal-configs` `scripts/adi-monitor.sh`)

Today it hard-codes 00:50Z (start checking) and 01:40Z (alert). v2 removes the clock maths from the
shell. On each 5-minute tick, for each date in {UTC yesterday, ET yesterday} (deduplicated), it GETs
`/api/v1/days/{date}`:

- `200 settled`: as today (recovery, a non-final notice).
- `404 unsettled`: the body already carries `publishBy`. Alert once `now ≥ publishBy + 10 min`.

This is DST-safe and cutover-safe. On `E` at 01:40Z it checks UTC-yesterday `E−1` (v1, due 01:30Z).
After the cutover the UTC-yesterday label is an ET day that has not ended, whose `publishBy` is in
the future, so it is silent. The monitor change ships in its own PR in `lexabu/personal-configs`
**before** v2 deploys, and the dry-run tests in section 8 cover it.

## 4. Indicative ET series during the notice period

Receipts are unchanged and archived from `2026-11-20T04:30Z`. A v2 print is a pure function of
receipts. So v2 prints for every past ET day can be computed now, without backfilling any source
data. ET day `2026-11-20` starts at `2026-11-20T05:00Z`, after the first round, so it is the first
ET day with full collection. (ET `2026-11-19` has 6 rounds and would print `suspended`.)

**Proposal (D4):**

- **Label.** "Indicative, methodology v2.0.0 (ET day). Not a settlement value." The print carries
  `standing: 'indicative'` **inside its hash**, so an indicative print cannot be passed off as a
  settlement print without breaking `printHash`. Settlement prints carry `standing: 'settlement'`.
- **Endpoints**, separate from the settlement ones so no client reads one by accident:
  - `GET /api/v1/indicative/days/{date}`: the indicative v2 print of ET day `date`, for
    `2026-11-20 ≤ date ≤ E−1`. `date ≥ E` returns 404 with `see: /api/v1/days/{date}`.
  - `GET /api/v1/indicative/history?from&to`: like `/history`.
  - `/api/v1/days`, `/history` and `/current` are unchanged in meaning: they serve whichever
    methodology is **in effect**.
- **Storage.** `indicative/2.0.0/{date}.json`, write-if-absent, immutable (an indicative print has
  no revisions). The settle cron builds yesterday's ET indicative print after the v1 settlement. A
  one-time operator command (`npm run indicative -- --from 2026-11-20`) writes the past days at
  launch. It reads receipts only, so it is reproducible like everything else.
- **Attestation: none of its own** (recommended). Every receipt an indicative print lists is already
  committed by the attested v1 prints of UTC days `D` and `D+1` (a v1 print lists every receipt of
  its day). `reproduce --indicative D` recomputes the print and also checks that each listed
  `receiptHash` appears in those two v1 prints. Then the attestations branch stays settlement-only,
  and `verify-attestation` keeps one meaning. The one exception is the gap hours: their receipts are
  in no v1 print, so the indicative print for `E−1` is the only one whose late hours are unattested.
  That is acceptable for a non-settlement print. The alternative is a separate
  `{date}.indicative.json` attestation.
- **How it becomes the settlement series.** It does not change label. From `E` on, the same code
  under the same release writes settlement prints at `/api/v1/days/{date}`. Indicative prints for
  `< E` stay published, frozen and marked indicative forever. They are never relabelled or
  "promoted", and they never become a correction. The ET track record is the indicative series
  through `E−1` followed by the settlement series from `E`. The site draws it as one ET chart, with
  the indicative part visibly distinct.

## 5. Data model and API

### Registry (`src/lib/index/releases.ts`, `methodology.ts`)

`MethodologyParameters` becomes a union discriminated on `day`, so v1's hashed object is untouched
(its hash `e9ef6e94…c363` stays pinned):

```ts
type CommonParameters = {
	version;
	name;
	unit;
	source;
	panel;
	slotMinutes: 5;
	roundAssignment;
	quorum: 1;
	observation;
	programs;
	minutesPerActiveSlot;
	carry;
	coverage;
	settlement;
};
type V1Parameters = CommonParameters & { day: 'utc'; slotsPerDay: 288 };
type ZonedParameters = CommonParameters & { day: { timeZone: 'America/New_York' } };
export type MethodologyParameters = V1Parameters | ZonedParameters;
```

`METHODOLOGY_V2 = { ...METHODOLOGY_V1-without-day-and-slotsPerDay, version: '2.0.0', day: { timeZone: 'America/New_York' } }`.
The time zone is a hashed parameter, so the hash changes, as it must. `slotsPerDay` is dropped from
v2 because it is no longer a constant. Each print states it in `coverage.slotsPerDay`. The
module-level `SLOTS_PER_DAY` constant is removed. Every reader asks the day's window instead.

`Methodology.effectiveFrom` stays a date label in the release's own zone. `methodologyFor(date)`
keeps working on labels, because labels stay ordered across the cutover: every label `< E` is a v1
UTC day and every label `≥ E` is a v2 ET day.

### One owner of day windows (`src/lib/index/time.ts`)

```ts
type DayWindow = { date: DayLabel; start: Date; end: Date; slots: number };
dayWindow(methodology, date): DayWindow   // the only place a boundary is computed
dayOf(methodology, instant): DayLabel      // which day an instant belongs to
```

`settlementCutoff`, `publicationDeadline`, `correctionDeadline`, `publicationCutoff` and
`elapsedSlots` all take a `DayWindow` and add their fixed duration. `parseRoundId` stops returning a
day: a round id names a UTC slot, and its day depends on the methodology. A branded `UtcDate` stays
for **storage partitions** only (`rounds/{utcDate}/…` and `days/{utcDate}.json` are unchanged). The
new `DayLabel` is for settlement days, so the two cannot be mixed up silently.

### Prints

New schema `adi.daily-print/2`, used for every v2 print. `printSchema` becomes a union, so every
stored `/1` print still parses and hashes exactly as before. `/2` adds, inside the hash:

- `window: { start, end }`, the exact instants covered. A reader never has to know tz rules to see
  what a print covers, and `reproduce` checks them against its own tz computation.
- `standing: 'settlement' | 'indicative'`.

`coverage.slotsPerDay` becomes 276, 288 or 300. `hourly` has 23, 24 or 25 entries. Everything else
is as in `/1`.

### Settlement reads

An ET day spans two UTC storage partitions. Settle reads the receipts of UTC dates `D` and `D+1`
(listing both prefixes) and keeps those whose slot is in the window. The running value reads the two
day indexes. A day index is a cache of one UTC partition and needs no change. That means at most 300
receipt reads per settle, against 288 today.

### API date semantics

- `/api/v1/days/{date}`: `date < E` is a UTC day (v1), `date ≥ E` is an ET day (v2). Every response
  carries `methodologyVersion` and, for `/2` prints, `window`, so the meaning of the label is
  stated. The unsettled 404 body adds `window`.
- `/api/v1/current`: today's settlement day in effect now. That is the UTC day before `E` and the ET
  day from `E`. Adds `window`.
- `/api/v1/history`: entries gain `methodologyVersion` and `window`. The default `to` becomes "the
  latest day whose cutoff has passed".
- `/api/v1/methodology`: adds `upcoming: { version, parameterHash, effectiveFrom, effectiveAt }`
  during the notice period, so machine readers see the change coming.
- `/api/v1/rounds/{id}`: unchanged.

### UI

- Day headings use the date label and the zone: "Thursday 2027-01-07 (ET)". Before `E`: "… (UTC)".
- Every instant (cutoff, deadline, last round, hour labels) is shown in **ET and UTC**, server
  rendered, plus the **viewer's local time**, added by a small client component (`<time dateTime>`,
  `Intl.DateTimeFormat` with the browser zone). Server HTML stays deterministic and cacheable.
- The hourly chart draws 23, 24 or 25 bars, labelled in ET with the UTC hour in the tooltip. A
  repeated fall-back hour is labelled "01:00 EDT" and "01:00 EST".
- During the notice period: a banner on `/`, `/methodology` and `/status` reading "From 2027-01-01
  the index is computed per US Eastern day. See the notice." Also an "Indicative ET series" section,
  visibly marked non-settlement.
- `/methodology`: describes v2 as current from `E`. The v1 text moves to a "v1.0.0 (UTC day), days
  through 2026-12-31" annex, unchanged, because v1 prints are still cited.

## 6. Reproduce and verify, v1 forever

- v1 code paths read the same parameters and produce the same instants. `dayWindow(v1, D)` is
  `[D 00:00Z, D+1 00:00Z)`, and every deadline formula gives the same instant for v1 days (section
  3). No v1 print, receipt or attestation is rewritten.
- `reproduce <date>` picks the methodology from the label, rebuilds under it, and compares. For a
  `/2` print it also checks `window` against its own tz computation, so a tzdata disagreement shows
  up as `MISMATCH` with the field named instead of a silent difference.
- `reproduce --indicative <date>` (new) does the same for an indicative print, plus the receipt
  inclusion check in section 4.
- `verify-attestation` takes its cutoff from `publicationCutoff(print)`, which now reads the print's
  window. For `/1` prints the window is derived as UTC, so the instants are identical.
- **Golden tests:** every production v1 print available at implementation time (2026-11-20 onward)
  is committed as a fixture. `printHash`, `settlesAt`, `publishBy`, `correctionDeadline` and
  `publicationCutoff` are pinned for each and must not move. The tag `v1.0.0` keeps reproducing them
  too. The release commit is tagged `v2.0.0`.

## 7. Public notice text

### Incident log entry (`docs/incidents.md`, newest first)

> **2026-MM-DD: methodology v2.0.0 announced, effective 2027-01-01 (ET).** From the day 2027-01-01,
> the index counts the civil day in America/New_York (US Eastern) instead of the UTC day. That is
> `[00:00, 24:00)` ET: 23 hours (276 slots) on the second Sunday of March and 25 hours (300 slots)
> on the first Sunday of November. The source, panel, slots, observation checks, carry ladder and
> coverage percentages are unchanged. The parameter hash changes to `<v2 hash>`. The last v1 (UTC)
> print is 2026-12-31. The first v2 print is 2027-01-01, which settles at 2027-01-02T05:30Z (00:30
> EST) and is published by 06:30Z. **The five hours 2027-01-01T00:00Z to 05:00Z (19:00 to 24:00 EST
> on 31 December) fall in no settlement print.** They are collected, archived and shown in the
> indicative series. Until then an indicative ET series, computed under v2 from the same archived
> receipts, is published at `/api/v1/indicative/…`. It is never a settlement value. No v1 print is
> changed or corrected. Discussion: issue #<n>.

### Methodology change entry (`docs/methodology.md`, a new "Version history" section)

> **v2.0.0, effective 2027-01-01 (ET).** Day boundary: UTC → America/New_York. Slots per day: 288 →
> 276/288/300. Coverage thresholds: unchanged percentages of the day's slots. Settlement cutoff,
> publication deadline and corrections window: unchanged durations after the day's end. Rule 4 now
> reads: "A new methodology version takes effect only at the start of a day under its own boundary
> …", and a round counts if its release has the same receipt parameters (section 2). Parameter hash
> `<v2 hash>`.
>
> **v1.0.0, 2026-11-17 to 2026-12-31 (UTC).** As published.

**Which rule.** The brief cites rule 8 for the incidents entry. The announcement requirement is
**rule 4** (incident log, at least 30 days ahead). Rule 8 governs corrections, and it applies here
only as a prohibition: corrections "are never used to apply a later methodology to past days", so no
v1 day is ever reprinted under v2. The design follows both rules.

## 8. Risks and test plan

### Risks

| Risk                                                                            | Mitigation                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tzdata differs between machines, or US DST law changes (e.g. permanent DST)     | tzdata keeps history, so past days do not move. `/2` prints state `window`, and `reproduce` flags disagreement by name. A law change is reviewed as a possible v3 with its own notice. |
| A reader mistakes a date label's zone (`2026-12-31` is UTC, `2027-01-01` is ET) | `window` and `methodologyVersion` in every response; zone shown beside every date on the site; the notice states the switch.                                                           |
| An indicative value is cited as settlement                                      | Separate endpoints, `standing` in the hash, banner, rule 2 unchanged (only `/api/v1/days` revision 1).                                                                                 |
| Settle crons misfire around DST or the cutover                                  | The "all due days in the last 48 h" default is idempotent. Both hour sets run all year. The monitor reads `publishBy` from the API.                                                    |
| The monitor or attest workflow ships late                                       | Both are cutover checklist items with dates. The monitor PR lands before the v2 deploy. The old attest schedule stays until `E−1` is attested.                                         |
| Receipt-compatibility rule widened by accident                                  | `ReceiptParameters` type; a test that changing any receipt parameter makes rounds foreign; a test that v1/v2 compatibility holds.                                                      |
| Reading two partitions doubles a failure surface in settle                      | Same verify-or-stop rule: any unreadable receipt in either partition stops the run, and the next retry tries again.                                                                    |
| The gap hours hold the day's worst disruption                                   | Stated in the notice. Accepted (D2).                                                                                                                                                   |

### Test plan (phase 2)

1. **Windows:** `dayWindow` for v1 dates is UTC. For ET: `2027-03-14` → 276 slots, `2026-11-01` and
   `2027-11-07` → 300, an ordinary day → 288. Property test over every ET date 2026–2035: windows
   tile (`end(D) = start(D+1)`), lengths are 23, 24 or 25 h, and starts are 5-minute aligned.
   `dayOf(instant)` round-trips.
2. **Coverage:** exact boundaries for each slot count (262/263, 220/221; 273/274, 230/231; 284/285,
   239/240).
3. **Aggregation:** 23 and 25 hourly buckets; the repeated fall-back hour; the ladder restarts at ET
   midnight and not at UTC midnight.
4. **Cutover integration** (extends `src/server/methodology-cutover.test.ts`): v1 day `E−1` and v2
   day `E` settle under their own releases; gap slots are in no settlement print; gap rounds are
   tagged v1 and count in indicative `E−1`; a v1-tagged round inside day `E` counts (compatible); a
   round under a test release with a different panel suspends the day; both days reproduce `MATCH`.
5. **Settle route:** default day selection across the cutover and both DST nights; `nothing_due`
   runs; retries after a print exists change nothing.
6. **Schemas:** every v1 fixture print parses and hash-matches unchanged; the v1 parameter hash is
   unchanged; the v2 hash is pinned; a `/2` print without `window` or `standing` is refused.
7. **Golden v1 timing:** pinned `settlesAt`, `publishBy`, correction deadline and attestation cutoff
   for every v1 fixture day.
8. **Reproduce and verify:** `npm run reproduce` and `npm run verify-attestation` against production
   v1 days (2026-11-20 onward) print `MATCH` on the phase-2 branch; `reproduce --indicative` matches
   for a fixture ET day, and fails if a receipt is missing from the v1 prints.
9. **Indicative:** `/api/v1/indicative/days/{date ≥ E}` returns 404 with the pointer; prints are
   write-if-absent.
10. **Monitor:** `adi-monitor.sh --dry-run --now <epoch>` at `E 01:40Z` (v1 alert path), at
    `2027-03-15T05:40Z` (EDT, alert) and at `2027-03-14T06:40Z` (EST, alert), and silent before each
    `publishBy + 10 min`.
11. **Attest workflow:** ET "yesterday" at 05:45Z and 06:45Z on both DST nights.
12. **UI:** ET, UTC and local rendering; DST-day charts.
13. **After cutover** (rollout checklist): reproduce `E−1` and `E`, both `MATCH`; then remove the v1
    crons and the `01:45Z` attest run.

## Decisions for review

| #   | Decision                                                                      | Recommendation                                                                               |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Effective date                                                                | `2027-01-01`, if the notice is live by `2026-12-02T05:00Z`; else the first ET day ≥ N + 30 d |
| D2  | Cutover gap of 5 h (4 h in EDT)                                               | Accept and state it                                                                          |
| D3  | Receipt-compatibility rule replacing strict version equality                  | Adopt                                                                                        |
| D4  | Indicative series: separate endpoints, `standing` in hash, no own attestation | Adopt                                                                                        |
| D5  | Thresholds as percentages of the day's slots (not fixed counts)               | Adopt                                                                                        |
| D6  | Value not normalized on 23/25-hour days                                       | Adopt; state it                                                                              |

## Settlement annex: the DST rule

This annex is normative for v2 and is copied into `docs/methodology.md` at release.

1. **Days follow America/New_York.** Day `D` is `[D 00:00, D+1 00:00)` in the IANA zone
   `America/New_York`, with the US DST rules in force for that date.
2. **Slot counts.** An ordinary day is 24 h and 288 slots. The spring-forward day (second Sunday of
   March) is 23 h and **276** slots. The fall-back day (first Sunday of November) is 25 h and
   **300** slots.
3. **Slots stay 5-minute, UTC-aligned.** A slot is `[t, t + 5 min)` with `t` a multiple of 5 minutes
   since the Unix epoch. Round ids are the UTC slot start. ET midnight is always a whole UTC hour,
   so a day is always a whole number of slots.
4. **Sample days** (exact UTC bounds):

   | ET day       | Kind                       | Starts (UTC)                       | Ends (UTC, exclusive)              | Length | Slots |
   | ------------ | -------------------------- | ---------------------------------- | ---------------------------------- | ------ | ----- |
   | `2027-03-14` | spring forward             | `2027-03-14T05:00:00Z` (00:00 EST) | `2027-03-15T04:00:00Z` (00:00 EDT) | 23 h   | 276   |
   | `2026-11-01` | fall back                  | `2026-11-01T04:00:00Z` (00:00 EDT) | `2026-11-02T05:00:00Z` (00:00 EST) | 25 h   | 300   |
   | `2027-11-07` | fall back (first under v2) | `2027-11-07T04:00:00Z` (00:00 EDT) | `2027-11-08T05:00:00Z` (00:00 EST) | 25 h   | 300   |
   | `2027-01-01` | ordinary (EST)             | `2027-01-01T05:00:00Z`             | `2027-01-02T05:00:00Z`             | 24 h   | 288   |

   (`2026-11-01` predates v2. It is shown as the worked fall-back example. `2027-11-07` is the first
   fall-back day v2 will settle.)

5. **Coverage thresholds are percentages of that day's slot count.** Status is decided in integers
   with no rounding: `final` iff `valid × 100 ≥ 95 × slots`, `degraded` iff
   `valid × 100 ≥ 80 × slots`, otherwise `suspended`. Equivalently, the minimum count is
   `ceil(percent × slots / 100)`: 263/221 (276 slots), 274/231 (288), 285/240 (300).
   `coverage.percent` is `round(valid / slots × 100, 2)`, for display only.
6. **Deadlines are durations from the day's end**, in instants: settlement cutoff +30 min,
   publication deadline +90 min, corrections window cutoff +24 h, r1 attestation cutoff end +24 h.
   On a fall-back night the publication deadline is the first 01:30 ET (EDT).
