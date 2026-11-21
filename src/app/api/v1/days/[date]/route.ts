import { parseUtcDate } from '@/lib/index/time';
import { CACHE, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { dayView } from '@/server/views';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ date: string }> }) {
	const { date } = await context.params;
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	const view = await dayView(storeFromEnv(), date);
	// Short-lived even when settled: a correction can replace the latest revision at any time.
	return json(view, CACHE.live, view.status === 'settled' ? 200 : 404);
}
