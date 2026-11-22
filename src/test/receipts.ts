import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { buildReceipt, type FetchOutcome } from '@/lib/index/round';
import type { RoundReceipt } from '@/lib/index/schemas';
import { collectingRelease } from '@/lib/index/calendar';

/** A receipt as the collector builds it: the release in effect then and the current adapter. */
export function collectedReceipt(input: {
	fetchedAt: Date;
	sourceUrl: string;
	outcome: FetchOutcome;
}): RoundReceipt {
	return buildReceipt({
		...input,
		methodology: collectingRelease(input.fetchedAt),
		adapterVersion: CURRENT_ADAPTER.version,
	});
}
