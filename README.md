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
