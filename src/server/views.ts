/** Read models for the public API, shaped for direct rendering. */
import { aggregateDay, type SlotState } from '@/lib/index/day';
import { methodologyInEffect } from '@/lib/index/methodology';
import type {
	Correction,
	DailyPrint,
	RoundReceipt,
	RoundSummary,
	UnrecognizedList,
} from '@/lib/index/schemas';
import {
	elapsedSlots,
	publicationDeadline,
	settlementCutoff,
	utcDateOf,
	type RoundId,
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
	// The slot open now: `pending` until its round arrives, then `observed`.
	const latestSlot: SlotState | undefined = day.slots[elapsed];
	if (latestSlot === undefined) throw new Error(`no open slot ${elapsed} on ${date}`);
	return {
		date,
		asOf: now.toISOString(),
		status: 'provisional' as const,
		settlesAt: settlementCutoff(date).toISOString(),
		publishBy: publicationDeadline(date).toISOString(),
		methodologyVersion: day.methodology.parameters.version,
		parameterHash: day.methodology.parameterHash,
		/** Rounds today under another methodology. Non-empty means today will print suspended. */
		foreignMethodologies: day.foreignMethodologies,
		/** Delay_type lists v1 does not know, seen in today's valid rounds. They never count. */
		unrecognizedLists: unrecognizedListsOf(index.rounds),
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

type UnrecognizedSighting = UnrecognizedList & { rounds: number; lastRoundId: RoundId };

/** Each distinct unrecognized list in `rounds`, with how many rounds carried it and the latest. */
function unrecognizedListsOf(rounds: readonly RoundSummary[]): UnrecognizedSighting[] {
	const sightings = new Map<string, UnrecognizedSighting>();
	for (const round of [...rounds].sort((x, y) => x.roundId.localeCompare(y.roundId))) {
		if (round.observation.status !== 'valid') continue;
		// A list repeated within one round counts that round once.
		const lists = new Map(
			round.observation.unrecognized.map((list) => [
				JSON.stringify([list.element, list.name]),
				list,
			]),
		);
		for (const [key, list] of lists) {
			const seen = sightings.get(key)?.rounds ?? 0;
			sightings.set(key, { ...list, rounds: seen + 1, lastRoundId: round.roundId });
		}
	}
	return [...sightings.values()];
}

export type DayView =
	| { date: UtcDate; status: 'settled'; print: DailyPrint; revisions: DailyPrint[] }
	| { date: UtcDate; status: 'unsettled'; settlesAt: string; publishBy: string };

/** A day's current print (latest revision) with every revision kept visible. */
export async function dayView(store: ObjectStore, date: UtcDate): Promise<DayView> {
	const revisions = await readPrints(store, date);
	const print = revisions.at(-1);
	if (print === undefined)
		return {
			date,
			status: 'unsettled',
			settlesAt: settlementCutoff(date).toISOString(),
			publishBy: publicationDeadline(date).toISOString(),
		};
	return { date, status: 'settled', print, revisions };
}

export async function historyView(store: ObjectStore, from: UtcDate, to: UtcDate) {
	const { days } = await readHistory(store);
	return {
		from,
		to,
		/** In effect on `to` (null before the first release); each print records its own. */
		methodologyVersion: methodologyInEffect(to)?.parameters.version ?? null,
		days: days
			.filter((day) => day.date >= from && day.date <= to)
			.map((day) => ({ ...day, url: `${API_BASE}/days/${day.date}` })),
	};
}

export type CorrectionEntry = Correction & {
	date: UtcDate;
	revision: number;
	printHash: string;
	url: string;
};

/**
 * Every correction print (revision 2 or later), most recently issued first. History cites each
 * day's latest revision, so only days it lists past revision 1 have their prints read.
 */
export async function correctionsView(store: ObjectStore): Promise<CorrectionEntry[]> {
	const { days } = await readHistory(store);
	const corrected = days.filter((day) => day.revision > 1);
	const prints = (await Promise.all(corrected.map((day) => readPrints(store, day.date)))).flat();
	return prints
		.flatMap(({ date, revision, printHash, correction }) =>
			correction === null
				? []
				: [{ date, revision, printHash, ...correction, url: `${API_BASE}/days/${date}` }],
		)
		.sort((x, y) => y.issuedAt.localeCompare(x.issuedAt));
}

/** A valid receipt is never replaced, so it caches forever; an invalid one never caches. */
export function roundCache(receipt: RoundReceipt): string {
	return receipt.observation.status === 'valid' ? CACHE.immutable : CACHE.none;
}
