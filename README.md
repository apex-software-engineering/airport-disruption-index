# airport-disruption-index

Airport Disruption Index: settlement-grade FAA ground-stop index (airports.apexsofteng.com)

## Source and reproducing

The source is public. Every number on the site can be reproduced from it; see the
[methodology](docs/methodology.md#reproducing).

```sh
git clone https://github.com/apex-software-engineering/airport-disruption-index && cd airport-disruption-index && npm ci
```

## Incidents

Incidents, corrections and methodology announcements are published as
[`incident` issues](https://github.com/apex-software-engineering/airport-disruption-index/issues?q=label%3Aincident)
until the site's `/incidents` page ships. See the
[settlement rules](docs/methodology.md#settlement-rules).

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
