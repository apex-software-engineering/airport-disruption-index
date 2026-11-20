import { addDays, dayStartMs, parseUtcDate, utcDateOf } from '@/lib/index/time';
import { CACHE, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { historyView } from '@/server/views';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

/** Settled days in [from, to]. Defaults to the 30 days ending yesterday. */
export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const to = params.get('to') ?? addDays(utcDateOf(new Date()), -1);
	if (parseUtcDate(to) === null) return problem(400, `invalid to ${to}`);
	const from = params.get('from') ?? addDays(to, 1 - DEFAULT_DAYS);
	if (parseUtcDate(from) === null) return problem(400, `invalid from ${from}`);
	const days = (dayStartMs(to) - dayStartMs(from)) / 86_400_000 + 1;
	if (days < 1 || days > MAX_DAYS) return problem(400, `range must be 1 to ${MAX_DAYS} days`);
	return json(await historyView(storeFromEnv(), from, to), CACHE.daily);
}
