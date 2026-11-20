/** Read models for the public API, shaped for direct rendering. */
import { aggregateDay, type SlotState } from '@/lib/index/day';
import { METHODOLOGY, PARAMETER_HASH } from '@/lib/index/methodology';
import type { DailyPrint } from '@/lib/index/schemas';
import {
	elapsedSlots,
	parseRoundId,
	settlementCutoff,
	utcDateOf,
	type UtcDate,
} from '@/lib/index/time';

import { readDayIndex, readHistory, readPrints } from './archive';
import { CACHE } from './http';
import type { ObjectStore } from './storage';

export const API_BASE = '/api/v1';
export const roundUrl = (id: string) => `${API_BASE}/rounds/${id}`;

/** Today's running (provisional) value as of `now`. */
export async function currentView(store: ObjectStore, now: Date) {
	const date = utcDateOf(now);
	const index = await readDayIndex(store, date);
	const day = aggregateDay(date, index.rounds, now);
	const elapsed = elapsedSlots(date, now);
	const lastRound = index.rounds.reduce<(typeof index.rounds)[number] | null>(
		(latest, round) => (latest === null || round.fetchedAt > latest.fetchedAt ? round : latest),
		null,
	);
	const latestSlot: SlotState | null = elapsed === 0 ? null : (day.slots[elapsed - 1] ?? null);
	return {
		date,
		asOf: now.toISOString(),
		status: 'provisional' as const,
		settlesAt: settlementCutoff(date).toISOString(),
		methodologyVersion: METHODOLOGY.version,
		parameterHash: PARAMETER_HASH,
		value: day.value,
		groundStopValue: day.groundStopValue,
		airports: day.airports,
		hourly: day.hourly,
		coverage: { ...day.coverage, elapsedSlots: elapsed },
		latestSlot,
		lastRound:
			lastRound === null
				? null
				: {
						roundId: lastRound.roundId,
						fetchedAt: lastRound.fetchedAt,
						status: lastRound.observation.status,
						receiptHash: lastRound.receiptHash,
						url: roundUrl(lastRound.roundId),
					},
	};
}

export type DayView =
	| { date: UtcDate; status: 'settled'; print: DailyPrint; revisions: DailyPrint[] }
	| { date: UtcDate; status: 'unsettled'; settlesAt: string };

/** A day's current print (latest revision) with every revision kept visible. */
export async function dayView(store: ObjectStore, date: UtcDate): Promise<DayView> {
	const revisions = await readPrints(store, date);
	const print = revisions.at(-1);
	if (print === undefined)
		return { date, status: 'unsettled', settlesAt: settlementCutoff(date).toISOString() };
	return { date, status: 'settled', print, revisions };
}

export async function historyView(store: ObjectStore, from: UtcDate, to: UtcDate) {
	const { days } = await readHistory(store);
	return {
		from,
		to,
		methodologyVersion: METHODOLOGY.version,
		days: days
			.filter((day) => day.date >= from && day.date <= to)
			.map((day) => ({ ...day, url: `${API_BASE}/days/${day.date}` })),
	};
}

/** A round can change only while its slot is open (an invalid attempt may be replaced). */
export function roundCache(id: string, now: Date): string {
	const parsed = parseRoundId(id);
	const slotEnd =
		parsed === null
			? Number.POSITIVE_INFINITY
			: parsed.slotStart.getTime() + METHODOLOGY.slotMinutes * 60_000;
	return slotEnd <= now.getTime() ? CACHE.immutable : CACHE.none;
}
