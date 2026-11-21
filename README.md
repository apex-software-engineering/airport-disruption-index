# airport-disruption-index

Airport Disruption Index: settlement-grade FAA ground-stop index (airports.apexsofteng.com)

## Source and reproducing

The source is public. Every number on the site can be reproduced from it; see the
[methodology](docs/methodology.md#reproducing).

```sh
git clone https://github.com/apex-software-engineering/airport-disruption-index && cd airport-disruption-index && npm ci
```

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
Vercel GitHub app is installed: `vercel deploy --prod` from `main` after merge, `vercel deploy` from
a branch for a preview.
