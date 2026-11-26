# Incidents

The operator, Apex Software Engineering LLC, records here every incident that affected collection,
settlement or publication, and every methodology announcement, newest first. Each entry gives the
UTC day, what happened and what it did to the prints. Correction prints are not written here: the
[incidents page](https://airports.apexsofteng.com/incidents) lists every one from the published
prints themselves, under this log.

## Log

<!-- log 2.0.0 -->

- **2026-11-29: methodology v2.0.0 announced, effective ET day 2027-01-01.**

  - **What changes.** From ET day 2027-01-01, each settlement print covers the civil day in
    America/New_York (US Eastern), `[00:00, 24:00)` ET, instead of the UTC day. Ordinary days have
    288 five-minute slots. The second Sunday of March has 23 hours (276 slots), and the first Sunday
    of November has 25 hours (300 slots). 2027-01-01 itself is an ordinary 288-slot day,
    `[2027-01-01T05:00Z, 2027-01-02T05:00Z)`. It settles at 2027-01-02T05:30Z (00:30 EST) and is
    published by 06:30Z (01:30 EST).
  - **What does not change.** The source, panel, slots, observation checks, carry ladder, coverage
    percentages (95% / 80% of the day's slots) and the durations of every deadline. The parameter
    hash changes to `a9fa10889b35417090d909d4f60d9cb9b429a9703d1b626c1c0a95182b7a76e6`.
  - **The last UTC print is 2026-12-31.** **The 5 hours from 2027-01-01T00:00Z to 05:00Z (19:00 to
    24:00 EST on 31 December, 60 slots) are in no settlement print.** They are collected and
    archived, and shown only in the indicative series. No v1 attestation covers them. Their receipt
    list is pinned once, after the fact, by a timestamped file `transition/2027-01-01.json` on the
    attestations branch.
  - **When it takes effect.** As v1 rule 4 requires, v2.0.0 takes effect at **00:00Z of a UTC day,
    2027-01-01T00:00Z**, at least 30 days after this notice. Its first settlement day, ET day
    2027-01-01, starts at 05:00Z (00:00 EST). No rule is amended. **That date is the target, and it
    holds only if** this notice's public readback is recorded and its timestamp proof reaches a
    Bitcoin block by 2026-12-02T00:00Z, and the follow-up registry change is deployed before
    2027-01-01T00:00Z. Otherwise v1.0.0 continues, and this log says so.
  - **Rules for v2 days.** The settlement rules become version-scoped. v1.0.0 days keep the v1 rules
    word for word. v2.0.0 days follow the v2 rules published with this notice, rules 1 to 8:
    - deadlines are durations from the day's end (cutoff +30 min, publication +90 min, corrections
      until cutoff +24 h);
    - a `final` day may miss 13, 14 or 15 rounds (276-, 288- and 300-slot days);
    - later versions take effect at 00:00 ET of a day. Admission stays strict: a settlement day
      counts only rounds collected under exactly its own version and parameter hash. Only the panel
      totals (ADI and ADI-GS) are settlement values; per-airport and hourly figures are
      informational.
  - **Indicative series.** Until then, an indicative ET series, computed under v2 from the same
    archived receipts, is at `/api/v1/indicative/…`, labelled "ADI (ET, indicative)". It is never a
    settlement value. Its admission policy accepts receipts collected under v1.0.0 or v2.0.0 and is
    stated in every indicative print.
  - **For exchanges and contract writers.** Pin the `parameterHash` (and version) in contract rules,
    and request prints with `?parameterHash=`. A pinned hash that does not own the requested day
    returns a machine-readable `parameter_hash_mismatch` 404 naming both hashes and the owning
    release. **Contract rules should name a fallback for that outcome**, as they would for a source
    that is unavailable. Do not write multi-day aggregates (weekly, monthly) that span 2026-12-31
    and 2027-01-01: they would mix a UTC day, the gap and an ET day. No v1 print is changed or
    corrected. Corrections are never used to apply v2 to past days (rule 8).
  - **Postponement or withdrawal.** Either is announced on this log **no later than
    2026-12-18T00:00Z**, 14 days before v2 takes effect. After that, v2 is no longer postponed or
    withdrawn, though it still takes effect only under the conditions above. A postponed v2 gets a
    new effective day at least 30 days after the postponement notice (a fresh 30 days). A withdrawn
    v2 leaves v1 in effect with no end date and ends the indicative series. Its published indicative
    prints stay, labelled indicative. Either way, no day is ever printed under two methodologies,
    and older deployments that carry the superseded date are retired from rollback.
  - **Effective-date record.** This entry is demonstrably public on the site at N, the instant
    recorded once by a public readback of this notice in `notices/2.0.0.readback.json` on the
    attestations branch and timestamped with OpenTimestamps. N and its proof's Bitcoin block time
    are added to this entry by the follow-up registry change.

  Discussion: issue #11.

<!-- /log -->

- **2026-11-20: partial day, collector started <time datetime="2026-11-20T04:30:00Z">04:30Z</time>,
  print degraded.** The collector's first round was `2026-11-20T04:30Z`, so the 54 slots from
  <time datetime="2026-11-20T00:00:00Z">00:00Z</time> to
  <time datetime="2026-11-20T04:25:00Z">04:25Z</time> have no round. Revision 1 printed `degraded`
  with 234 of 288 valid rounds (81.25% coverage): its value is published for information and is not
  a settlement value (settlement rule 1). No correction.
