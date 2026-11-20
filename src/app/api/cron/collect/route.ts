import { collectRound, fetchSourceFeed } from '@/server/collector';
import { CACHE, cronAuthorized, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { roundUrl } from '@/server/views';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Vercel Cron, every 5 minutes. Safe to call again: a second round in a slot is a duplicate. */
export async function GET(request: Request) {
	if (!cronAuthorized(request)) return problem(401, 'unauthorized');
	const { outcome, receipt } = await collectRound(storeFromEnv(), fetchSourceFeed);
	return json(
		{
			outcome,
			roundId: receipt.roundId,
			status: receipt.observation.status,
			receiptHash: receipt.receiptHash,
			url: roundUrl(receipt.roundId),
		},
		CACHE.none,
	);
}
