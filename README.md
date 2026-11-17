# airport-disruption-index

Airport Disruption Index: settlement-grade FAA ground-stop index (airports.apexsofteng.com)

## Development

Node 24 and npm.

```sh
npm ci
npm run dev
npm run lint && npm run format:check && npm run type-check && npm test && npm run build
```

Pushes to `main` deploy to production on Vercel (`lexabus-projects/airport-disruption-index`); pull
requests get preview deployments.
