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

The command writes to the store the environment names. Pull the Vercel environment to a file outside
the repo and load it without printing it (the file sets `BLOB_READ_WRITE_TOKEN` and `VERCEL_ENV`,
which picks the `prod` or `preview` namespace). Then add the incident to `docs/incidents.md` and
check the new revision:

```sh
vercel env pull --yes --environment=production /tmp/adi-prod.env
set -a && . /tmp/adi-prod.env && set +a
npm run correct -- 2026-11-20 --supersedes <printHash of the latest revision> --reason "<what was wrong>"
rm /tmp/adi-prod.env
npm run reproduce -- 2026-11-20
```

The command prints the store it writes to, the new revision and its `printHash`. Rehearse on a
preview first: `--environment=preview` writes only to the `preview` namespace.

## Development

Node 24 and npm.

```sh
npm ci
npm run dev
npm run lint && npm run format:check && npm run type-check && npm test && npm run build
```

Deploys go to Vercel (`lexabus-projects/airport-disruption-index`) through the Vercel CLI until the
Vercel GitHub app is installed: `vercel deploy --prod` from `main` after merge, `vercel deploy` from
a branch for a preview.

## Monitoring

An external check runs outside Vercel every 5 minutes (a launchd job on a separate host, not part of
this repo) and alerts the operator on Discord:

- Live index: `/api/v1/current` is not HTTP 200, or it returns 200 but `lastRound.fetchedAt` is
  missing, null or unparseable, or that time is more than 15 minutes old. One alert per incident,
  and one recovery message after an alert that was actually sent.
- Daily print: the monitor polls `/api/v1/days/{yesterday UTC}` on its 5-minute run. 00:50Z and
  01:40Z are thresholds checked on those polls, not scheduled jobs. Polling starts on the first run
  at or after 00:50Z. If the print is still unavailable on a poll at or after 01:40Z, ten minutes
  after the 01:30Z publication deadline, it sends one alert. A recovery message follows only an
  alert that was actually sent.
- Quiet note: if the print the monitor sees when it marks the day done has a status other than
  `final` (`degraded` or `suspended`), it sends one quieter note. If that Discord post fails, the
  next poll retries and can see a newer revision. Once the day is marked done, later revisions are
  skipped. The API status `settled` only means a print has been published; whether a day is eligible
  for settlement requires `final` under the Settlement rules in docs/methodology.md.

The GitHub scheduled smoke run (`.github/workflows/smoke.yml`, every 6 hours) stays as a slower,
independent check; GitHub does not run it on time.
