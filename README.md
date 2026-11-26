# airport-disruption-index

Airport Disruption Index: settlement-grade FAA ground-stop index (airports.apexsofteng.com)

## Source and reproducing

The source is public. Every number on the site can be reproduced from it; see the
[methodology](docs/methodology.md#reproducing).

```sh
git clone https://github.com/apex-software-engineering/airport-disruption-index && cd airport-disruption-index && npm ci
```

## Incidents

Incidents, corrections and methodology announcements are published at
[airports.apexsofteng.com/incidents](https://airports.apexsofteng.com/incidents): the operator's log
in [docs/incidents.md](docs/incidents.md), then every correction print. Each is discussed in an
[`incident` issue](https://github.com/apex-software-engineering/airport-disruption-index/issues?q=label%3Aincident).
See the [settlement rules](docs/methodology.md#settlement-rules).

## Corrections

Only the operator issues a correction print (settlement rule 8). The command rebuilds the day from
its stored receipts and writes the next revision. It refuses a hash that is not the day's latest
revision, and after D+2 00:30Z it refuses unless `--override-window` gives a justification, which
the print records. Earlier revisions are never touched.

The command writes to the store its environment names, and prints which one. Run it as below: the
Vercel environment is pulled into a private temporary directory that is deleted on exit, read as
data (never sourced into the shell), and only the Blob token and an explicit `VERCEL_ENV` reach the
command. `VERCEL_ENV` picks the namespace (`production` writes `prod/`). Unset `ADI_DATA_DIR` first:
if both are set the command warns and uses the filesystem store.

```sh
(
  set -eu
  dir=$(mktemp -d) && chmod 700 "$dir" && trap 'rm -rf "$dir"' EXIT
  vercel env pull --yes --environment=production "$dir/vercel.env" >/dev/null
  token=$(sed -n 's/^BLOB_READ_WRITE_TOKEN="\(.*\)"$/\1/p' "$dir/vercel.env")
  test -n "$token"
  BLOB_READ_WRITE_TOKEN="$token" VERCEL_ENV=production \
    npm run correct -- 2026-11-20 --supersedes <printHash of the latest revision> --reason "<what was wrong>"
)
```

The command prints the new revision and its `printHash`. The API serves it within 5 minutes (its CDN
cache). Then reproduce the day and check that the revision and `printHash` it reports are the ones
the command printed, and add the incident to `docs/incidents.md`:

```sh
npm run reproduce -- 2026-11-20
```

**Rehearse on a preview first.** Use `--environment=preview` and `VERCEL_ENV=preview`, which write
only to the `preview/` namespace, after settling a day there through the settle route (called as
below, with the preview's URL and its bypass header). Reproduce against the preview, with
`VERCEL_AUTOMATION_BYPASS_SECRET` set for its deployment protection:
`npm run reproduce -- <date> --base-url <preview URL>`, and check the revision and `printHash` the
same way.

**If the history index was not updated.** The print is written first. If the command then reports
that the history index still cites the previous revision, call the authenticated settle route for
that day. It finds the stored print and points history at the latest revision without rebuilding
anything. `CRON_SECRET` is a Sensitive Vercel variable, which `vercel env pull` does not return, so
paste the operator's copy at the silent prompt; the header file keeps it out of the process list:

```sh
(
  set -eu
  dir=$(mktemp -d) && chmod 700 "$dir" && trap 'rm -rf "$dir"' EXIT
  printf 'CRON_SECRET: ' && read -rs secret && echo
  printf 'Authorization: Bearer %s\n' "$secret" > "$dir/auth"
  curl -fsS -H @"$dir/auth" "https://airports.apexsofteng.com/api/cron/settle?date=2026-11-20"
)
```

The incidents page lists correction prints from the stored prints, so it shows the correction even
before history is repaired.

## Licence

The code is licensed under the [Apache License 2.0](LICENSE). The index values, prints and receipts
are licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); credit them as
"Airport Disruption Index by Apex Software Engineering LLC". The FAA source data is a US Government
work and is not subject to copyright in the US. See the [terms of use](docs/terms.md), the
[disclaimer](docs/disclaimer.md) and the [independence policy](docs/independence.md).

## Development

Node 24 and npm.

```sh
npm ci
npm run dev
npm run lint && npm run format:check && npm run type-check && npm test && npm run build
```

Deploys go to Vercel (`lexabus-projects/airport-disruption-index`) through the Vercel CLI until the
Vercel GitHub app is installed. Build locally from a clean checkout so the API can report the
deployed commit (`deployedCommit` in `/api/v1/methodology`; a remote CLI build has no `.git` and
reports null): `vercel build --prod && vercel deploy --prebuilt --prod` from `main` after merge,
`vercel build && vercel deploy --prebuilt` from a branch for a preview.

## Attestations branch

The attest workflow appends to the `attestations` branch (see
[methodology](docs/methodology.md#attestations)). Its ruleset blocks force-pushes and deleting the
branch; ordinary commits still land. If a file that is not an attestation gets pushed there, remove
it with a new commit: `git worktree add /tmp/adi-attestations origin/attestations`, then
`git -C /tmp/adi-attestations rm <file>`, commit, and
`git -C /tmp/adi-attestations push origin HEAD:attestations`. Until then each run only warns about
it. Never edit or remove a `{date}.r{revision}.json` file: `verify-attestation` treats any change to
one after its first commit as a failure. A proof (`.ots`) may change only by `ots upgrade`.

**Notice step 1.** The commit that sets a release's `noticePublishedAt` deploys before that instant:
the notice (incidents entry, versioned rules, banner, `upcoming`, indicative series) appears at it,
and its dated text states it. If the deploy slips past the instant, move `noticePublishedAt` to the
next 00:00Z first; the docs test fails until the dated text moves with it. The notice markers in
`docs/` stay until the postponement deadline has passed (a withdrawal brings back the
`before-notice` passages), and a later cleanup PR removes them.

**Notice readback.** After a methodology notice deploys, run the notice-readback workflow
(`.github/workflows/notice-readback.yml`) by hand; it also runs every 15 minutes, and its first job
stops at once before the notice instant or once the record's proof reaches a Bitcoin block. A run
that sees the notice on `/incidents` (the dated entry and the hash), `/methodology` (the release's
rules) and `/api/v1/methodology` (`upcoming`) writes the single record
`notices/{version}.readback.json` and, beside it, the three response bodies it hashes
(`.incidents.html`, `.methodology.html`, `.methodology.json`), stamps the record and publishes them;
a run that does not writes nothing. N is the latest of the responses' `Date` headers, the run's
start and the runner's own clock once all responses are in; the record names the run and its
attempt, and the commit links the run. Later runs upgrade the proof until it reaches a block (B).
Nothing is ever rewritten; if the proof is ever lost, stamp the same bytes again. The CLI reads only
the production site, and refuses a redirected response, a redirect (never followed), a `Date` that
is not an HTTP-date or lies more than 5 minutes after or an hour before its own clock around the
request, a response naming no deployed commit, and a headline or hash that is not in the page's
visible text. Locally:
`npm run notice-readback -- 2.0.0 --run-id <id> --run-attempt <n> --run-started-at <ISO> --dir <checkout>`
(exit 3: not public yet).

## Monitoring

An external check runs outside Vercel every 5 minutes (a launchd job on a separate host, not part of
this repo) and alerts the operator on Discord:

- Live index: `/api/v1/current` is not HTTP 200, or it returns 200 but `lastRound.fetchedAt` is
  missing or unparseable, or that time is more than 15 minutes old. A null `lastRound` (no round
  ever stored, as on a fresh preview store) is reported as "no data yet", not as a stall. One alert
  per incident, and one recovery message after an alert that was actually sent.
- Daily print: on each 5-minute run the monitor polls `/api/v1/days/{date}` for UTC yesterday, ET
  yesterday, and every day whose late alert is still open. An unsettled day answers 404 with its own
  `publishBy`; if a poll at or after `publishBy` + 10 minutes still finds it unsettled, the monitor
  sends one alert. The monitor computes no deadlines itself: UTC days (01:30Z), ET days (01:30 EDT
  or EST) and DST nights all use the deadline the API states. A response naming
  `misfiled.problem == "misfiled_print"` alerts at once, listing `misfiled.objects`. A recovery
  message follows only an alert that was actually sent.
- Quiet note: if the print the monitor sees when it marks the day done has a status other than
  `final` (`degraded` or `suspended`), it sends one quieter note. If that Discord post fails, the
  next poll retries and can see a newer revision. Once the day is marked done, later revisions are
  skipped. The API status `settled` only means a print has been published; whether a day is eligible
  for settlement requires `final` under the Settlement rules in docs/methodology.md.

The GitHub scheduled smoke run (`.github/workflows/smoke.yml`, every 6 hours) stays as a slower,
independent check; GitHub does not run it on time.
