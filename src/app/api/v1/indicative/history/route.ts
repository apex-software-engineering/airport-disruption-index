import {
	FIRST_INDICATIVE_DAY,
	INDICATIVE_UNPUBLISHED,
	indicativeSeriesPublished,
} from '@/lib/index/indicative';
import { addDays, dayStartMs, parseUtcDate, utcDateOf } from '@/lib/index/time';
import { CACHE, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { indicativeHistoryView } from '@/server/views';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

/** Frozen indicative ET days in [from, to]. Defaults to the 30 days ending yesterday (UTC). */
export async function GET(request: Request) {
	if (!indicativeSeriesPublished()) return problem(404, INDICATIVE_UNPUBLISHED);
	const params = new URL(request.url).searchParams;
	const to = params.get('to') ?? addDays(utcDateOf(new Date()), -1);
	if (parseUtcDate(to) === null) return problem(400, `invalid to ${to}`);
	const from = params.get('from') ?? laterOf(addDays(to, 1 - DEFAULT_DAYS), FIRST_INDICATIVE_DAY);
	if (parseUtcDate(from) === null) return problem(400, `invalid from ${from}`);
	const days = (dayStartMs(to) - dayStartMs(from)) / 86_400_000 + 1;
	if (days < 1 || days > MAX_DAYS) return problem(400, `range must be 1 to ${MAX_DAYS} days`);
	return json(await indicativeHistoryView(storeFromEnv(), from, to), CACHE.live);
}

function laterOf(a: string, b: string): string {
	return a > b ? a : b;
}
