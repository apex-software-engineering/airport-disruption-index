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
- The root may hold only `Update_Time`, `Dtd_File` and `Delay_type`, the elements every archived and
  sampled production payload carries (feed adapter `faa-nas-xml/2` onward). Any other root element
  fails the round (`unrecognized_structure`), because a renamed wrapper would otherwise read as an
  all-clear. A calm payload with no `Delay_type` block is valid.
- A `Delay_type` block named `Ground Stop Programs` or `Ground Delay Programs` must hold exactly its
  own list (`Ground_Stop_List` or `Ground_Delay_List`), once, and nothing else (feed adapter
  `faa-nas-xml/2` onward). A renamed list, an extra or repeated list, no list or the other program's
  list fails the round (`unrecognized_structure`), because a renamed list under a counted name would
  otherwise read as an all-clear.
- Receipts parsed by `faa-nas-xml/1`, which made neither structure check, are still rebuilt with
  that rule.

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

| Check                                                                                                                                                  | Reason if it fails       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| A response arrived (15 s timeout)                                                                                                                      | `network_error`          |
| HTTP status is 200                                                                                                                                     | `http_status`            |
| The body is UTF-8, well-formed XML with root `AIRPORT_STATUS_INFORMATION`, a parseable `Update_Time` and well-formed GS/GDP lists                      | `parse_error`            |
| The root holds only `Update_Time`, `Dtd_File` and `Delay_type`, and each counted-program block holds exactly its list (adapter `faa-nas-xml/2` onward) | `unrecognized_structure` |
| `Update_Time` is at most **900 s** before `fetchedAt`                                                                                                  | `stale_feed`             |
| `Update_Time` is at most **120 s** after `fetchedAt`                                                                                                   | `feed_ahead_of_clock`    |

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
- A **print** (`GET /api/v1/days/{date}`) contains: date, revision, correction (null on revision 1;
  see [Revisions](#revisions)), methodology version, parameter hash, `settlesAt`, coverage, the
  result (status, value, GS-only value, per-airport minutes and hourly series, or for a suspended
  day only a reason), every round's id, status and `receiptHash`, and `printHash`.
- `printHash` = sha256 of the canonical JSON of the print without `printHash`.

### Revisions

None after settlement, except a **correction print**: revision 2 or later. Its `correction` names
the `printHash` it supersedes (`supersedesPrintHash`) and states the `reason`, records when the
operator issued it (`issuedAt`), and holds `windowOverride`: null, or the written justification for
a correction issued after its window (rule 8). The original stays published (`revisions` in the day
response lists every revision; `print` is the latest). Corrections exist for operational faults such
as a misconfigured deployment. They are never used to apply a later methodology to past days. Who
may issue one, and until when, is under [Settlement rules](#settlement-rules).

## Settlement rules

These rules decide what a contract that cites the index settles on. Where a rule and the rest of
this document disagree, the rule wins and the disagreement is a documentation bug.

1. **Only `final` prints are settlement-eligible.** A `degraded` print and a `suspended` print are
   published, hashed and archived like any other, but neither is a settlement value. A `degraded`
   value is shown for information only.
2. **The print is revision 1 of `GET /api/v1/days/{date}`**, unless a correction replaces it under
   rule 8. Nothing else (the running value, `/api/v1/history`, the site) is a settlement value.
3. **Gaps in the data can move the value either way, by a bounded amount.** A slot with no valid
   round carries the last observed state for at most 2 slots (10 minutes), then contributes 0. A
   carried slot can overcount (a program that ended during the gap is counted until the carry runs
   out) or undercount (one that started during the gap is missed), by at most 10 airport-minutes per
   airport per gap. A `missing` slot only ever undercounts. A `final` day can lack up to 14 valid
   rounds and still settle. Nothing is estimated or backfilled to compensate, and the v1 calculation
   is exactly as described above.
4. **One methodology per day.** A new methodology version takes effect only at 00:00Z of a UTC day
   and is announced on the [incident log](#incident-log) at least 30 days (**PROVISIONAL, pending
   owner decision**) before (see
   [Changes to the source or the methodology](#changes-to-the-source-or-the-methodology)). Each
   version stays in the code with the day it takes effect, so day D is always computed under the
   version in effect on D, and an archived receipt is always validated and reproduced under the
   version it records. Every round records the version and parameter hash it was collected under. If
   any of a day's rounds carries a version or parameter hash other than the one in effect that day
   (for example from a collector still running the previous release), the day prints `suspended`
   with the reason `mixed methodology` and the number of rounds found under each other version; it
   never prints a value mixed from two methodologies. Such rounds are not counted in the running
   value either, and `/api/v1/current` lists them in `foreignMethodologies`.
5. **Feed data the index cannot read never settles.** Redirects are not followed, so a moved feed
   makes rounds invalid (`network_error` or `http_status`); a changed GS or GDP list fails the round
   (`parse_error`), and so does an element at the root the feed has never carried or a
   counted-program block that does not hold exactly its list (`unrecognized_structure`). An invalid
   round counts as not received: it only lowers coverage, and the coverage thresholds alone decide
   the status. A few rejected rounds therefore leave a day `final` (up to 14 can be missing), and
   more make it `degraded` or `suspended`. The index never reads a value from data it cannot parse.
   Restoring collection is a source-adapter fix or a methodology change, as defined under
   [Changes to the source or the methodology](#changes-to-the-source-or-the-methodology), and
   neither ever applies to a day already printed.
6. **New list types are recorded and flagged, never counted.** A `Delay_type` block with a name v1
   does not count, holding a list v1 does not know, is recorded in the receipt as `unrecognized`:
   the round stays valid, and any unrecognized list seen in today's valid rounds is listed in
   `unrecognizedLists` in `/api/v1/current` and on [/status](/status), so a feed change that could
   hide a program is visible the same day. A block named for a counted program
   (`Ground Stop Programs` or `Ground Delay Programs`) is different: anything but exactly its own
   list makes the round invalid (`unrecognized_structure`) under rule 5, so a renamed GS or GDP list
   fails closed instead of reading as an all-clear. If the FAA starts reporting ground stops or
   ground delay programs under a new name and list, v1 undercounts until a methodology change counts
   it.
7. **Publication deadline and retries.** The print for day D is due by **D+1 01:30Z**. The settle
   job runs at 00:30Z and retries at 00:45Z and 01:00Z. A run that finds no print reads every
   receipt of the day and checks it against its `receiptHash`; a receipt that cannot be read or
   verified stops that run without printing anything, and the next run tries again. A run that finds
   a print already stored reads no receipts: it returns that print and points the history index at
   the day's latest revision, which repairs a history update that failed after the print was
   written. If no print exists at the deadline the operator opens an incident on the
   [incident log](#incident-log). **A late print is still the print**: it is built by the same rules
   from the same receipts, and lateness alone never changes its status or value.
8. **Corrections.** Only Apex Software Engineering LLC, the operator, issues a correction print
   (revision 2 or later, see [Revisions](#revisions)), with `npm run correct` (see the
   [README](https://github.com/apex-software-engineering/airport-disruption-index#corrections)). A
   correction supersedes the day's latest revision and nothing else. It is rebuilt from the day's
   stored receipts under the methodology the superseded print records, so it reproduces like
   revision 1. A correction for day D may be issued only until **D+2 00:30Z**: 24 hours after the
   settlement cutoff, so never more than 24 hours after the original print was published. After that
   the print stands, unless the operator issues a correction with a written justification, which the
   print records in `windowOverride` for anyone to judge; the print schema refuses a late correction
   without one. Every correction print is listed on the [incident log](#incident-log) with the
   superseded `printHash`, the reason and the time it was issued, and every revision stays
   published.

### Incident log

Incidents, corrections and methodology announcements are published on the site's
[incidents page](incidents.md). It shows the operator's log, kept in the repository as
`docs/incidents.md`, followed by every correction print, listed from the published prints
themselves. Each is discussed in an
[`incident` issue](https://github.com/apex-software-engineering/airport-disruption-index/issues?q=label%3Aincident)
in the public repository.

### Changes to the source or the methodology

There are two kinds of change. In both, feed data that is invalid or not recognized stays
fail-closed: it is recorded, never counted and never settles (rules 5 and 6).

**A source-adapter fix** changes how the same FAA data is fetched or parsed (a new address or a new
shape), while what is measured, the formula and every parameter stay the same.

- The methodology version and parameter hash do not change.
- It ships without the methodology notice period, with an entry on the [incident log](#incident-log)
  and a line in the changelog (the pull request that ships it).
- Each receipt records the adapter that produced it in `adapterVersion`, and is always rebuilt with
  that adapter. Receipts written before the field existed omit it and were all produced by the first
  adapter, `faa-nas-xml/1`; their hashes are unchanged.
- It passes the same reproduce check as any release: every published round and print still
  reproduces with `MATCH`.
- The repair time is a **target, not a guarantee**: one US federal business day (America/New_York)
  from the monitor's first alert, a target, not a guarantee (**PROVISIONAL, pending owner
  decision**). The clock starts at detection (the monitor's first alert). A business day is a US
  federal business day in America/New_York.

**A methodology change** is anything that changes what is measured or how: a parameter, the panel,
or how events become airport-minutes. It is a new version with a new parameter hash (see
[Versioning](#versioning)), announced on the [incident log](#incident-log) at least 30 days
(**PROVISIONAL, pending owner decision**) before it takes effect, and it takes effect at 00:00Z of a
UTC day under rule 4.

## Receipts

Every round, valid or not, is stored as a receipt (`GET /api/v1/rounds/{id}`) with its raw response
body (`GET /api/v1/rounds/{id}/raw`, the bytes exactly as received):

`roundId`, `slotStart`, `fetchedAt`, `sourceUrl`, `adapterVersion` (absent on receipts written
before it existed), `httpStatus`, `rawSha256` (sha256 of the body bytes), `rawBytes`,
`methodologyVersion`, `parameterHash`, and `observation`. A valid observation holds
`feedUpdateTime`, the parsed GS/GDP events, the ignored and unrecognized `Delay_type` lists, and
per-panel-airport state. An invalid one holds the reason, a detail and `feedUpdateTime` when it
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
`receiptHash`, re-parses the body, rebuilds the receipt with the same calculation code under the
methodology version and feed adapter the receipt records, and compares every field. For a day, it
does that for every round the print lists, then rebuilds the print under the version in effect on
that day and compares; a `suspended` mixed-methodology day reproduces like any other. It prints
`MATCH` or `MISMATCH` with the differing fields. Exit codes: 0 match, 1 mismatch, 2 could not verify
(unreachable, not found, or published under a methodology version or feed adapter this checkout does
not include; check out a later commit, or the tag for that version, e.g. `git checkout v1.0.0`).

### Attestations

Receipts and prints live in the operator's storage, so on their own the hashes prove only that the
archive agrees with the code. Each settled day is also pinned outside that storage, on the
`attestations` branch of the public repo. A ruleset blocks force-pushes, deletion of that branch and
merge commits, with no bypass, so its history only grows and stays linear. That property comes from
the ruleset: the workflow's `GITHUB_TOKEN` can write anywhere in the repo, and the workflow chooses
to push only there.

At 01:45Z the attest workflow (`.github/workflows/attest.yml`) reconciles the last 7 days ending
yesterday. For each settled day whose current print has no attestation, it reproduces the print from
the public API and, only on `MATCH`, writes `{date}.r{revision}.json`:

`schema`, `date`, `revision`, `printHash`, `roundsDigest` (sha256 of the print's receipt hashes in
the order the print lists them, joined by `\n`), `parameterHash`, `methodologyVersion` and
`deployedCommit` (the `X-Deployed-Commit` header of the same `/api/v1/days/{date}` response; null
when the deployment could not say).

It stamps the file with [OpenTimestamps](https://opentimestamps.org), commits the proof beside it as
`{date}.r{revision}.json.ots`, and fails the run for any day it cannot attest. The check, the
reproduction and the attestation all use one `/days` response. A day already attested is checked
again instead; an attestation is never rewritten. Only the files a run is about to publish gate its
publication, after their proofs are parsed again: a file that fails is withheld. An invalid proof
from an earlier day is reported as an error and fails the run at the end, but never holds back a new
day. The reproducing job reads only the public API and cannot write; the publishing job pushes only
the files that run produced to the `attestations` branch, and warns about, without touching, any
other file there. Neither holds a storage or deployment secret. Two limits are accepted: the
deployed-commit check warns once per new attestation, not again later; and the timestamp checks look
blocks up at mempool.space, so an outage there fails the run loudly, by design, and the next run
retries.

**Publication cutoff.** The attestation for revision 1 of day D counts only if the earliest Bitcoin
block its proof reaches reports a header time before **D+2 00:00Z**. A correction (revision 2 or
later) must be stamped within **48 hours of that revision's issue time**, as recorded in the print's
`correction.issuedAt` (`correction` is null on revision 1). The check is against the header time the
block's miner reported, not a wall clock. Consensus only bounds it: it must be later than the median
of the previous 11 blocks' times, and no more than two hours ahead of the network's time when the
block was accepted. So the cutoff is a rule about that reported time, and says only roughly when the
attestation existed. The OpenTimestamps calendars keep the first commitment they receive,
independently of the operator, so a rewritten attestation would need a new and later timestamp,
which the cutoff exposes. What this does not cover: between settlement (D+1 00:30Z) and the first
stamp at 01:45Z the operator could still rewrite a print before it is attested. That window is about
75 minutes a day, longer when GitHub starts the scheduled run late.

A fresh proof is pending until a calendar's Bitcoin transaction confirms, usually within a few
hours. Each run upgrades pending proofs so they stop needing a calendar. Until then the
attestation's time cannot be proven: a pending proof fails `ots verify` and gives `PENDING` below.

To check a print against its attestation and its time, from the checkout:

```sh
git worktree add attestations origin/attestations
npm run verify-attestation -- 2026-11-20 --base-url https://airports.apexsofteng.com
```

(`git fetch origin` then `git -C attestations checkout --detach origin/attestations` updates it
later.) The directory must be a full, not shallow, checkout whose HEAD is the tip of
`origin/attestations` (`--dir` and `--branch` change either); anything else exits 2, because a stale
or partial history could hide a rewrite. It also asks GitHub for the branch's live tip
(`git ls-remote`) and exits 2 ("stale checkout, fetch first") if that has moved on. Offline, it
warns and checks the branch as of your last fetch: freshness then depends on having fetched.
`verify-attestation` fetches the day and checks that `print` is the last of its `revisions`. It
reads every attestation ever committed for that date from the branch history, as first committed,
diffing each commit against its first parent: a later modification or deletion of one is a failure.
Any merge commit in the branch history is also a failure, since the ruleset forbids them and a
first-parent walk is only complete on a linear history. Every attested revision must still be served
by the API (a missing one is a rollback) and match it: `printHash` (which the print must hash to),
`roundsDigest`, `parameterHash` and `methodologyVersion`. The current revision must have an
attestation. For each attestation it then reads the proof, checks that it commits to the file's
first-committed bytes, and looks up its earliest Bitcoin block at a public block explorer
(mempool.space) to check the merkle root and the cutoff. Exit codes: 0 `MATCH`, 1 `MISMATCH`
(including an invalid proof or one after the cutoff), 2 could not verify, 3 `UNATTESTED` (the
current print has no attestation), 4 `PENDING` (everything matches but the proof has not reached a
Bitcoin block yet).

`reproduce` checks the archive against the code; its `MATCH` says nothing about time. Only
`verify-attestation` returning `MATCH` shows that the print served today is the one attested before
the cutoff. To check the Bitcoin block without trusting a block explorer, run `ots verify` against
your own Bitcoin node:

```sh
pipx install opentimestamps-client==0.8.0
ots verify attestations/2026-11-20.r1.json.ots
```

`deployedCommit` names the commit the deployment was built from. It is set only when the build could
know it: a Vercel git build, or a build from a clean checkout (`vercel build` then
`vercel deploy --prebuilt`); otherwise it is `unknown`. Every API response carries it in the
`X-Deployed-Commit` header. The workflow checks that an attested deployed commit is in the public
repo. Each methodology version is tagged at the commit that released it (`v1.0.0`).

## Versioning

Any change to a parameter, to the panel, or to how events become airport-minutes is a new
methodology version with a new parameter hash. A version takes effect at a UTC day boundary only
(see [Settlement rules](#settlement-rules), rule 4). Every released version stays in the code with
the day it takes effect, so older days keep settling, validating and reproducing under their own
parameters. A source-adapter fix is not a methodology version (see
[Changes to the source or the methodology](#changes-to-the-source-or-the-methodology)). A change
that can move the value without any change in disruption (for example a different panel) is a
**level break**. History is never rescaled or chain-linked, and a print always carries the version
it was computed under.

## Operations

These notes bind whoever deploys the index.

- **Rollbacks.** Receipts written from this release on record `adapterVersion` inside their hash. An
  older deployment cannot read the field and would rebuild them without it, so every rollback target
  must include this release's receipt reader (`src/lib/index/adapters.ts`). Never roll back past it.
  Once any correction print exists, the floor rises: every rollback target must also include the
  correction-aware print reader (`correction.issuedAt` and `correction.windowOverride` in
  `src/lib/index/schemas.ts`). An older reader drops those fields when it parses the print, so it
  would serve a correction whose contents no longer match its `printHash`.
- **Never remove a release or an adapter.** Every entry in `src/lib/index/releases.ts` and
  `src/lib/index/adapters.ts` stays for as long as any receipt or print cites it. An adapter
  revision is frozen once any production receipt records it: a later fix is a new revision. Preview
  receipts are not authoritative and do not freeze one.

### v2 rollout checklist

1. Add v2 to `src/lib/index/releases.ts` with an `effectiveFrom` day at least 30 days
   (**PROVISIONAL, pending owner decision**) after the announcement on the
   [incident log](#incident-log), and pin its parameter hash in `src/lib/index/methodology.test.ts`.
   Keep v1 in the registry: v1 days keep settling under v1 until v1's last day has printed, and
   reproducing under v1 forever.
2. Deploy before the effective day, so no collector runs v1-only code past the cutover (rounds it
   writes would make the first v2 day `suspended`).
3. Expect cached responses to lag the 00:00Z cutover: `/api/v1/methodology` caches for up to an hour
   at the edge, the `/methodology` page re-renders hourly, and `/api/v1/current` can be up to five
   minutes stale. Purge the edge cache just after 00:00Z, or say in the announcement that these may
   show the previous version for up to an hour.
4. After the first v2 day prints, run `npm run reproduce` on it and on the last v1 day; both must
   print `MATCH`.

## Out of scope for v1

- Backfill before the first production round: see "History / backfill" in [sources.md](sources.md).
- Ground stop end times, delay magnitudes (`Avg`/`Max`), closures, arrival/departure delays and
  airspace flow programs.
