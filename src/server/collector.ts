/** One collection round: poll the feed once, build the receipt, archive it. */
import { METHODOLOGY } from '@/lib/index/methodology';
import { buildReceipt, type FetchOutcome } from '@/lib/index/round';

import { recordRound, type RecordResult } from './archive';
import type { ObjectStore } from './storage';

export const USER_AGENT =
	'airport-disruption-index-collector/1.0 (+https://airports.apexsofteng.com)';
const FETCH_TIMEOUT_MS = 15_000;

export type FetchedFeed = { fetchedAt: Date; outcome: FetchOutcome };
export type FeedFetcher = () => Promise<FetchedFeed>;

/** GETs the source feed. `fetchedAt` is when the whole body has arrived. */
export const fetchSourceFeed: FeedFetcher = async () => {
	try {
		const response = await fetch(METHODOLOGY.source.url, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const body = new Uint8Array(await response.arrayBuffer());
		return {
			fetchedAt: new Date(),
			outcome: { kind: 'response', httpStatus: response.status, body },
		};
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return { fetchedAt: new Date(), outcome: { kind: 'network_error', detail } };
	}
};

export async function collectRound(
	store: ObjectStore,
	fetchFeed: FeedFetcher,
	clock: () => Date = () => new Date(),
): Promise<RecordResult> {
	const { fetchedAt, outcome } = await fetchFeed();
	const receipt = buildReceipt({ fetchedAt, sourceUrl: METHODOLOGY.source.url, outcome });
	const body = outcome.kind === 'response' ? outcome.body : null;
	return recordRound(store, receipt, body, clock());
}
