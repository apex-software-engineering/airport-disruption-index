/**
 * One settle run (design §3): the named days settled and the due indicative days frozen, all
 * concurrently, each attempt under its own deadline, so a stalled storage request fails only its
 * own attempt and the run still answers. Abandoned work is safe: every print and index write is
 * conditional, so it can only store the same print later, never overwrite one.
 */
import { dueIndicativeDays, indicativeSeriesPublished } from '@/lib/index/indicative';
import type { SettledStatus } from '@/lib/index/schemas';

import { misfiledPrints, settleDay, SettlementBlocked, type MisfiledPrints } from './archive';
import { freezeIndicativeDay } from './indicative-archive';
import type { ObjectStore } from './storage';

/**
 * How long one day's whole attempt (its settlement and the misfiled lookup after it), or one
 * freeze, may take: 270 s, so a run still answers within the settle route's 300 s maxDuration.
 */
export const ATTEMPT_DEADLINE_MS = 270_000;

export type SettleRun = { settled: Settled[]; indicative: Frozen[] };

/** Settles each of `dates` and freezes every due indicative day, each within `deadlineMs`. */
export async function runSettle(
	store: ObjectStore,
	now: Date,
	dates: readonly string[],
	deadlineMs = ATTEMPT_DEADLINE_MS,
): Promise<SettleRun> {
	const [settled, indicative] = await Promise.all([
		Promise.all(dates.map((date) => settle(store, date, deadlineMs))),
		freezeDue(store, now, deadlineMs),
	]);
	return { settled, indicative };
}

/** One day's outcome. `misfiled` lists objects for the date no reader serves (a stale write). */
export type Settled =
	| {
			date: string;
			status: 'settled' | 'already_settled';
			result: SettledStatus;
			printHash: string;
			misfiled?: MisfiledPrints;
	  }
	| { date: string; status: 'blocked'; misfiled: MisfiledPrints }
	| { date: string; status: 'failed'; reason: string };

/** `work`, or a rejection once `deadlineMs` has passed. */
async function withinDeadline<T>(what: string, deadlineMs: number, work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} did not finish within ${deadlineMs / 1000} s`)),
			deadlineMs,
		);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function settle(store: ObjectStore, date: string, deadlineMs: number): Promise<Settled> {
	try {
		// The deadline covers the diagnostic lookup too: the run waits on nothing unbounded.
		const { status, print, misfiled } = await withinDeadline(
			`settling ${date}`,
			deadlineMs,
			settleDay(store, date).then(async (outcome) => ({
				...outcome,
				misfiled: await misfiledPrints(store, date),
			})),
		);
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

/** 500 when any day failed, else 409 when any was blocked, else 200. */
export function httpStatusOf(settled: readonly Settled[]): 200 | 409 | 500 {
	if (settled.some((day) => day.status === 'failed')) return 500;
	return settled.some((day) => day.status === 'blocked') ? 409 : 200;
}

/** Dates looked back over for indicative days to freeze: enough to cover a missed day of runs. */
const INDICATIVE_LOOKBACK_DAYS = 3;

type Frozen = Awaited<ReturnType<typeof freezeDue>>[number];

/** Freezes every due indicative day, each independently. None before the series is published. */
async function freezeDue(store: ObjectStore, now: Date, deadlineMs: number) {
	const due = indicativeSeriesPublished() ? dueIndicativeDays(now, INDICATIVE_LOOKBACK_DAYS) : [];
	return Promise.all(
		due.map(async (date) => {
			try {
				const { status, print } = await withinDeadline(
					`freezing ${date}`,
					deadlineMs,
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
