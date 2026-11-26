import {
	misfiledPrints,
	settleDay,
	SettlementBlocked,
	type MisfiledPrints,
} from '@/server/archive';
import { freezeIndicativeDay } from '@/server/indicative-archive';
import { CACHE, cronAuthorized, json, problem } from '@/server/http';
import { storeFromEnv, type ObjectStore } from '@/server/storage';
import { dayWindow, dueSettlementDays, settlesAt } from '@/lib/index/calendar';
import { dueIndicativeDays, indicativeSeriesPublished } from '@/lib/index/indicative';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import type { SettledStatus } from '@/lib/index/schemas';
import { parseUtcDate } from '@/lib/index/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, design §3): 00:30Z with retries at 00:45Z and 01:00Z for v1's UTC days,
 * and 04:30Z (EDT) or 05:30Z (EST) with retries 15 and 30 minutes later for ET days, each run
 * ending before the day's publication deadline.
 *
 * Without `?date`, every settlement day whose cutoff passed in the last 48 hours is attempted, each
 * independently: one that fails or is blocked never stops another. `already_settled` repoints the
 * history at the latest revision; `nothing_due` means no day was due. `?date=YYYY-MM-DD` settles
 * that past day at any age (the operator's recovery path), and refuses it before its cutoff.
 *
 * Every authorized run also freezes the indicative ET days (design §4) of the last few dates whose
 * freeze time has passed, whatever the settlements do.
 *
 * Every day and every freeze runs concurrently under its own deadline (ATTEMPT_DEADLINE_MS), so a
 * stalled storage request fails only its own attempt and the run still answers within
 * maxDuration. Abandoned work is safe: every print and index write is conditional, so it can only
 * store the same print later, never overwrite one.
 *
 * The status is 500 when any day failed, else 409 when any was blocked (its print key holds
 * something else, reported as `misfiled` and never overwritten), else 200.
 */
export async function GET(request: Request) {
	if (!cronAuthorized(request)) return problem(401, 'unauthorized');
	const now = new Date();
	const store = storeFromEnv();
	const named = new URL(request.url).searchParams.get('date');
	if (named === null) {
		const [settled, indicative] = await Promise.all([
			Promise.all(dueSettlementDays(now).map(({ window }) => settle(store, window.date))),
			freezeDue(store, now),
		]);
		const status = settled.length === 0 ? 'nothing_due' : 'ran';
		return json({ status, settled, indicative }, CACHE.none, httpStatusOf(settled));
	}
	if (parseUtcDate(named) === null) return problem(400, `invalid date ${named}`);
	const release = settlementReleaseOrNull(named);
	if (release === null)
		return problem(400, `no methodology is in effect on ${named}, so it has nothing to settle`);
	const cutoff = settlesAt(dayWindow(release, named));
	if (now < cutoff) return problem(409, `${named} settles at ${cutoff.toISOString()}`);
	const [settled, indicative] = await Promise.all([settle(store, named), freezeDue(store, now)]);
	return json({ ...settled, indicative }, CACHE.none, httpStatusOf([settled]));
}

/** One day's outcome. `misfiled` lists objects for the date no reader serves (a stale write). */
type Settled =
	| {
			date: string;
			status: 'settled' | 'already_settled';
			result: SettledStatus;
			printHash: string;
			misfiled?: MisfiledPrints;
	  }
	| { date: string; status: 'blocked'; misfiled: MisfiledPrints }
	| { date: string; status: 'failed'; reason: string };

/** How long one day's settlement, or one freeze, may take: a run still answers in maxDuration. */
export const ATTEMPT_DEADLINE_MS = (maxDuration - 30) * 1000;

/** `work`, or a rejection once ATTEMPT_DEADLINE_MS has passed. */
async function withinDeadline<T>(what: string, work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} did not finish within ${ATTEMPT_DEADLINE_MS / 1000} s`)),
			ATTEMPT_DEADLINE_MS,
		);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function settle(store: ObjectStore, date: string): Promise<Settled> {
	try {
		const { status, print } = await withinDeadline(`settling ${date}`, settleDay(store, date));
		const misfiled = await misfiledPrints(store, date);
		return {
			date,
			status,
			result: print.result.status,
			printHash: print.printHash,
			...(misfiled === null ? {} : { misfiled }),
		};
	} catch (error) {
		if (error instanceof SettlementBlocked) {
			return { date, status: 'blocked', misfiled: error.misfiled };
		}
		console.error(`settle ${date} failed`, error);
		return { date, status: 'failed', reason: reasonOf(error) };
	}
}

function httpStatusOf(settled: readonly Settled[]): 200 | 409 | 500 {
	if (settled.some((day) => day.status === 'failed')) return 500;
	return settled.some((day) => day.status === 'blocked') ? 409 : 200;
}

/** Dates looked back over for indicative days to freeze: enough to cover a missed day of runs. */
const INDICATIVE_LOOKBACK_DAYS = 3;

/** Freezes every due indicative day, each independently. None before the series is published. */
async function freezeDue(store: ObjectStore, now: Date) {
	const due = indicativeSeriesPublished() ? dueIndicativeDays(now, INDICATIVE_LOOKBACK_DAYS) : [];
	return Promise.all(
		due.map(async (date) => {
			try {
				const { status, print } = await withinDeadline(
					`freezing ${date}`,
					freezeIndicativeDay(store, date, now),
				);
				return { date, status, result: print.result.status, printHash: print.printHash };
			} catch (error) {
				console.error(`indicative freeze ${date} failed`, error);
				return { date, status: 'failed' as const, reason: reasonOf(error) };
			}
		}),
	);
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
