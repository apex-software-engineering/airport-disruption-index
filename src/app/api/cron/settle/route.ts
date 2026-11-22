import { freezeIndicativeDay, settleDay } from '@/server/archive';
import { CACHE, cronAuthorized, json, problem } from '@/server/http';
import { storeFromEnv, type ObjectStore } from '@/server/storage';
import { dayWindow, settlesAt } from '@/lib/index/calendar';
import { dueIndicativeDays } from '@/lib/index/indicative';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import { addDays, parseUtcDate, utcDateOf } from '@/lib/index/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron at 00:30Z, with retries at 00:45Z and 01:00Z (vercel.json): settles yesterday,
 * before the 01:30Z publication deadline. A retry after a settled run is a no-op that returns
 * `already_settled`. `?date=YYYY-MM-DD` settles another past day.
 *
 * Each run then freezes the indicative ET days (design §4) of the last few dates whose freeze time
 * has passed and that are not frozen yet, each independently: one failing never stops another, or
 * the settlement.
 */
export async function GET(request: Request) {
	if (!cronAuthorized(request)) return problem(401, 'unauthorized');
	const now = new Date();
	const date = new URL(request.url).searchParams.get('date') ?? addDays(utcDateOf(now), -1);
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	const release = settlementReleaseOrNull(date);
	if (release === null)
		return problem(400, `no methodology is in effect on ${date}, so it has nothing to settle`);
	if (release.parameters.day !== 'utc')
		return problem(
			409,
			`${date} is an ${release.parameters.day.timeZone} day; settling those days is not available yet`,
		);
	const cutoff = settlesAt(dayWindow(release, date));
	if (now < cutoff) return problem(409, `${date} settles at ${cutoff.toISOString()}`);
	const store = storeFromEnv();
	const { status, print } = await settleDay(store, date);
	const indicative = [];
	for (const day of dueIndicativeDays(now, INDICATIVE_LOOKBACK_DAYS)) {
		indicative.push(await freezeIndicative(store, day, now));
	}
	return json(
		{ status, date, result: print.result.status, printHash: print.printHash, indicative },
		CACHE.none,
	);
}

/** Dates looked back over for indicative days to freeze: enough to cover a missed day of runs. */
const INDICATIVE_LOOKBACK_DAYS = 3;

async function freezeIndicative(store: ObjectStore, date: string, now: Date) {
	try {
		const { status, print } = await freezeIndicativeDay(store, date, now);
		return { date, status, result: print.result.status, printHash: print.printHash };
	} catch (error) {
		return {
			date,
			status: 'failed' as const,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
