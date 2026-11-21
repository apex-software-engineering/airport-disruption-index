import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { methodologyFor } from '@/lib/index/methodology';
import { buildReceipt, type FetchOutcome } from '@/lib/index/round';
import type { RoundReceipt } from '@/lib/index/schemas';
import { utcDateOf } from '@/lib/index/time';

/** A receipt as the collector builds it: today's methodology and the current adapter. */
export function collectedReceipt(input: {
	fetchedAt: Date;
	sourceUrl: string;
	outcome: FetchOutcome;
}): RoundReceipt {
	return buildReceipt({
		...input,
		methodology: methodologyFor(utcDateOf(input.fetchedAt)),
		adapterVersion: CURRENT_ADAPTER.version,
	});
}
