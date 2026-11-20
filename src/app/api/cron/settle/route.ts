import { settleDay } from '@/server/archive';
import { CACHE, cronAuthorized, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { addDays, parseUtcDate, settlementCutoff, utcDateOf } from '@/lib/index/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Vercel Cron, daily at 00:30Z: settles yesterday. `?date=YYYY-MM-DD` settles another past day. */
export async function GET(request: Request) {
	if (!cronAuthorized(request)) return problem(401, 'unauthorized');
	const now = new Date();
	const date = new URL(request.url).searchParams.get('date') ?? addDays(utcDateOf(now), -1);
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	const cutoff = settlementCutoff(date);
	if (now < cutoff) return problem(409, `${date} settles at ${cutoff.toISOString()}`);
	const { status, print } = await settleDay(storeFromEnv(), date);
	return json(
		{ status, date, result: print.result.status, printHash: print.printHash },
		CACHE.none,
	);
}
