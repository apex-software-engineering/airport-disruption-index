import { collectRound } from '@/server/collector';
import type { ObjectStore } from '@/server/storage';

import { feedFixtureText } from './fixtures';

/**
 * Collects one round fetched at `at` into `store`, as the deployed collector would: the GS/GDP
 * fixture (SFO GDP, LGA GS and GDP) stamped a minute before the fetch, stored a second after it.
 */
export function collectAt(store: ObjectStore, at: string) {
	const fetchedAt = new Date(at);
	const stamp = new Date(fetchedAt.getTime() - 60_000)
		.toUTCString()
		.replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/, '$1 $3 $2 $5 $4 GMT');
	const xml = feedFixtureText('synthetic-gs-gdp.xml').replace(
		'Tue Nov 17 20:43:54 2026 GMT',
		stamp,
	);
	return collectRound(
		store,
		async () => ({
			fetchedAt,
			outcome: { kind: 'response', httpStatus: 200, body: new TextEncoder().encode(xml) },
		}),
		() => new Date(fetchedAt.getTime() + 1000),
	);
}
