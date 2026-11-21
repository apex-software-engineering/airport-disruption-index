# airport-disruption-index

Airport Disruption Index: settlement-grade FAA ground-stop index (airports.apexsofteng.com)

## Source and reproducing

The source is public. Every number on the site can be reproduced from it; see the
[methodology](docs/methodology.md#reproducing).

```sh
git clone https://github.com/apex-software-engineering/airport-disruption-index && cd airport-disruption-index && npm ci
```

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

- `/api/v1/current` is not HTTP 200, or `lastRound.fetchedAt` is more than 15 minutes old. One alert
  per incident and one recovery message.
- `/api/v1/days/{yesterday UTC}` is not settled by 01:40Z, ten minutes after the 01:30Z publication
  deadline (first checked at 00:50Z). One alert, and a recovery if it settles late.
- A day that settles with a print status other than `final` produces one quieter note.

The GitHub scheduled smoke run (`.github/workflows/smoke.yml`, every 6 hours) stays as a slower,
independent check; GitHub does not run it on time.
