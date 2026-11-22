/** Read models for the public API, shaped for direct rendering. */
import {
	dayAt,
	elapsedSlots,
	partitionsOf,
	publishBy,
	settlementDay,
	settlesAt,
	slotIndexIn,
	type DayWindow,
	type SettlementDay,
} from '@/lib/index/calendar';
import { aggregateDay, type SlotState } from '@/lib/index/day';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import type {
	Correction,
	DailyPrint,
	RoundReceipt,
	RoundSummary,
	UnrecognizedList,
} from '@/lib/index/schemas';
import { parseRoundId, utcDateOf, type RoundId, type UtcDate } from '@/lib/index/time';

import { readCorrectionPrints, readDayIndex, readHistory, readPrints } from './archive';
import { CACHE } from './http';
import type { ObjectStore } from './storage';

export const API_BASE = '/api/v1';
export const roundUrl = (id: string) => `${API_BASE}/rounds/${id}`;

/**
 * Today's running (provisional) value as of `now`, or, between the last day of one release and
 * the first day of the next, the transition with no value. The collection heartbeat (`asOf`,
 * `lastRound`) is in both shapes.
 */
export async function currentView(store: ObjectStore, now: Date) {
	const at = dayAt(now);
	if (at.kind === 'transition') {
		const rounds = (await readDayIndex(store, utcDateOf(now))).rounds;
		return {
			status: 'transition' as const,
			asOf: now.toISOString(),
			previousDay: deadlinesOf(at.previous),
			nextDay: { date: at.next.date, startsAt: at.next.start.toISOString() },
			lastRound: lastRoundOf(rounds),
		};
	}
	return provisionalView(store, at, now);
}

async function provisionalView(store: ObjectStore, today: SettlementDay, now: Date) {
	const { window } = today;
	const rounds = await readWindowRounds(store, window);
	const day = aggregateDay(today, rounds, now);
	const elapsed = elapsedSlots(window, now);
	// The slot open now: `pending` until its round arrives, then `observed`.
	const latestSlot: SlotState | undefined = day.slots[elapsed];
	if (latestSlot === undefined) throw new Error(`no open slot ${elapsed} on ${window.date}`);
	const deadlines = deadlinesOf(window);
	return {
		date: deadlines.date,
		asOf: now.toISOString(),
		status: 'provisional' as const,
		settlesAt: deadlines.settlesAt,
		publishBy: deadlines.publishBy,
		methodologyVersion: day.methodology.parameters.version,
		parameterHash: day.methodology.parameterHash,
		/** Rounds today under another methodology. Non-empty means today will print suspended. */
		foreignMethodologies: day.foreignMethodologies,
		/** Delay_type lists v1 does not know, seen in today's valid rounds. They never count. */
		unrecognizedLists: unrecognizedListsOf(rounds),
		value: day.value,
		groundStopValue: day.groundStopValue,
		airports: day.airports,
		hourly: day.hourly,
		coverage: { ...day.coverage, elapsedSlots: elapsed },
		latestSlot,
		lastRound: lastRoundOf(rounds),
	};
}

function deadlinesOf(window: DayWindow) {
	return {
		date: window.date,
		settlesAt: settlesAt(window).toISOString(),
		publishBy: publishBy(window).toISOString(),
	};
}

/** The summaries of every stored round whose slot is in `window`, across its partitions. */
async function readWindowRounds(store: ObjectStore, window: DayWindow): Promise<RoundSummary[]> {
	const indexes = await Promise.all(partitionsOf(window).map((date) => readDayIndex(store, date)));
	return indexes
		.flatMap((index) => index.rounds)
		.filter((round) => {
			const id = parseRoundId(round.roundId);
			return id !== null && slotIndexIn(window, id.slotStart) !== null;
		});
}

/** The most recently fetched of `rounds`, as the heartbeat reports it. */
function lastRoundOf(rounds: readonly RoundSummary[]) {
	const last = rounds.reduce<RoundSummary | null>(
		(latest, round) => (latest === null || round.fetchedAt > latest.fetchedAt ? round : latest),
		null,
	);
	return last === null
		? null
		: {
				roundId: last.roundId,
				fetchedAt: last.fetchedAt,
				status: last.observation.status,
				receiptHash: last.receiptHash,
				url: roundUrl(last.roundId),
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
	if (print === undefined) {
		const deadlines = deadlinesOf(settlementDay(date).window);
		return {
			date,
			status: 'unsettled',
			settlesAt: deadlines.settlesAt,
			publishBy: deadlines.publishBy,
		};
	}
	return { date, status: 'settled', print, revisions };
}

export async function historyView(store: ObjectStore, from: UtcDate, to: UtcDate) {
	const { days } = await readHistory(store);
	return {
		from,
		to,
		/** In effect on `to` (null before the first release); each print records its own. */
		methodologyVersion: settlementReleaseOrNull(to)?.parameters.version ?? null,
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

/** Every stored correction print (revision 2 or later), most recently issued first. */
export async function correctionsView(store: ObjectStore): Promise<CorrectionEntry[]> {
	return (await readCorrectionPrints(store))
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
