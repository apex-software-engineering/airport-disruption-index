/**
 * The home chart's model: the daily prints and today's running value, exactly as the public API
 * serves them (`/api/v1/history` days and `/api/v1/current`), cut into the 1W / 1M / All ranges.
 * Nothing is padded, interpolated or smoothed: a range holds only the prints that exist, a
 * suspended day has no value, and a day with no print is simply absent.
 */
import type { HistoryEntry } from '@/lib/index/schemas';
import { dayStartMs, type UtcDate } from '@/lib/index/time';

import { formatInteger } from './format';

const DAY_MS = 86_400_000;

/** A day from `/api/v1/history`, as the API serves it. */
export type SeriesPrint = Pick<
	HistoryEntry,
	'date' | 'status' | 'value' | 'groundStopValue' | 'coveragePercent'
>;

/** Today's running value from `/api/v1/current`, only once it has a valid round. */
export type SeriesToday = {
	date: UtcDate;
	value: number;
	groundStopValue: number;
	coveragePercent: number;
	asOf: string;
};

type Common = {
	date: UtcDate;
	/** Whole days since the epoch, the chart's x position. */
	day: number;
	coveragePercent: number;
};

export type ChartPoint =
	| (Common & { status: 'final' | 'degraded'; value: number; groundStopValue: number })
	| (Common & { status: 'suspended' })
	| (Common & { status: 'provisional'; value: number; groundStopValue: number; asOf: string });

export type ValuedPoint = Exclude<ChartPoint, { status: 'suspended' }>;

export const RANGE_IDS = ['1W', '1M', 'all'] as const;
export type RangeId = (typeof RANGE_IDS)[number];

const RANGE_SPECS: Record<RangeId, { label: string; days: number | null }> = {
	'1W': { label: '1W', days: 7 },
	'1M': { label: '1M', days: 30 },
	all: { label: 'All', days: null },
};

export type RangeView = {
	id: RangeId;
	label: string;
	/** A range that would show exactly what the next longer one shows is offered disabled. */
	disabledReason: string | null;
	/** The calendar days the x axis spans, inclusive. */
	firstDay: number;
	lastDay: number;
	points: ChartPoint[];
	lines: Lines;
	bands: SuspendedBand[];
	/** The public API requests that, together, return every point in the range. */
	sources: string[];
	/** The range in words, for screen readers. */
	summary: string;
};

/**
 * How the points join up. A solid run joins settled prints on consecutive days only, so a
 * suspended day or a day with no print breaks the line. Today's running value joins yesterday's
 * print, when there is one, with a dashed link.
 */
export type Lines = {
	runs: ValuedPoint[][];
	provisionalLink: [ValuedPoint, ValuedPoint] | null;
};

/** Consecutive suspended days, drawn as one band so it never spills over a neighbouring day. */
export type SuspendedBand = { firstDay: number; lastDay: number };

export type Headline = {
	latest: ValuedPoint;
	/** The last final print before `latest`, which the change is measured against. */
	previousFinal: { date: UtcDate; value: number } | null;
};

export type ChartModel = {
	ranges: RangeView[];
	initial: RangeId;
	/** Null when no day has a value: every print is suspended and today has no running value. */
	headline: Headline | null;
	finalCount: number;
};

/** The public endpoints the chart reads, and the longest span one history request returns. */
export type ApiSource = { history: string; current: string; maxHistoryDays: number };

function pointOf(print: SeriesPrint): ChartPoint {
	const common = {
		date: print.date,
		day: dayStartMs(print.date) / DAY_MS,
		coveragePercent: print.coveragePercent,
	};
	if (print.status === 'suspended') {
		if (print.value !== null || print.groundStopValue !== null) {
			throw new Error(`${print.date} is suspended but carries a value`);
		}
		return { ...common, status: 'suspended' };
	}
	if (print.value === null || print.groundStopValue === null) {
		throw new Error(`${print.date} is ${print.status} but has no value`);
	}
	return {
		...common,
		status: print.status,
		value: print.value,
		groundStopValue: print.groundStopValue,
	};
}

/** Every print oldest first, then today's running value, which can only follow them. */
export function chartPoints(
	prints: readonly SeriesPrint[],
	today: SeriesToday | null,
): ChartPoint[] {
	const points = prints.map(pointOf);
	for (let index = 1; index < points.length; index++) {
		const [previous, point] = [points[index - 1], points[index]];
		if (previous !== undefined && point !== undefined && point.day <= previous.day) {
			throw new Error(`prints out of order: ${previous.date} then ${point.date}`);
		}
	}
	if (today === null) return points;
	const day = dayStartMs(today.date) / DAY_MS;
	const last = points.at(-1);
	if (last !== undefined && day <= last.day) {
		throw new Error(`today ${today.date} already has a print`);
	}
	return [...points, { ...today, day, status: 'provisional' }];
}

const isValued = (point: ChartPoint): point is ValuedPoint => point.status !== 'suspended';

export function linesOf(points: readonly ChartPoint[]): Lines {
	const runs: ValuedPoint[][] = [];
	let run: ValuedPoint[] = [];
	let provisionalLink: Lines['provisionalLink'] = null;
	let previous: ChartPoint | undefined;
	for (const point of points) {
		// The valued point on the day before, which this point joins.
		const before =
			previous !== undefined && isValued(previous) && point.day === previous.day + 1
				? previous
				: null;
		if (point.status === 'final' || point.status === 'degraded') {
			if (before === null && run.length > 0) {
				runs.push(run);
				run = [];
			}
			run.push(point);
		} else {
			if (run.length > 0) runs.push(run);
			run = [];
			if (point.status === 'provisional' && before !== null) {
				provisionalLink = [before, point];
			}
		}
		previous = point;
	}
	if (run.length > 0) runs.push(run);
	return { runs, provisionalLink };
}

export function bandsOf(points: readonly ChartPoint[]): SuspendedBand[] {
	const bands: SuspendedBand[] = [];
	for (const point of points) {
		if (point.status !== 'suspended') continue;
		const last = bands.at(-1);
		if (last !== undefined && last.lastDay === point.day - 1) last.lastDay = point.day;
		else bands.push({ firstDay: point.day, lastDay: point.day });
	}
	return bands;
}

export function headlineOf(points: readonly ChartPoint[]): Headline | null {
	const latest = points.findLast(isValued);
	if (latest === undefined) return null;
	const previous = points.findLast((point) => point.status === 'final' && point.day < latest.day);
	return {
		latest,
		previousFinal:
			previous === undefined || previous.status !== 'final'
				? null
				: { date: previous.date, value: previous.value },
	};
}

function describeRange(points: readonly ChartPoint[]): string {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined) return 'No prints in this range.';
	const count = (status: ChartPoint['status']) =>
		points.filter((point) => point.status === status).length;
	const span =
		first === last
			? `1 point, ${first.date} (UTC)`
			: `${points.length} points across the ${last.day - first.day + 1} days from ${first.date} to ${last.date} (UTC)`;
	const latest = points.findLast(isValued);
	const latestText =
		latest === undefined
			? 'No day in this range has a value.'
			: `Latest: ${formatInteger(latest.value)} airport-minutes on ${latest.date}${latest.status === 'provisional' ? ', today so far, provisional' : `, ${latest.status}`}.`;
	return `Daily ADI, ${span}: ${count('final')} final, ${count('degraded')} degraded, ${count('suspended')} suspended${count('provisional') > 0 ? ', and today so far (provisional)' : ''}. ${latestText}`;
}

function dateOfDay(day: number): UtcDate {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The history requests covering `firstDay`..`historyTo`, oldest first, each no longer than one
 * request may span, so together they return every print in the range, however long.
 */
export function historyRequests(firstDay: number, historyTo: UtcDate, api: ApiSource): string[] {
	const lastDay = dayStartMs(historyTo) / DAY_MS;
	const requests: string[] = [];
	for (let from = firstDay; from <= lastDay; from += api.maxHistoryDays) {
		const to = Math.min(from + api.maxHistoryDays - 1, lastDay);
		requests.push(`${api.history}?from=${dateOfDay(from)}&to=${dateOfDay(to)}`);
	}
	return requests;
}

function sourcesOf(
	points: readonly ChartPoint[],
	firstDay: number,
	historyTo: UtcDate,
	api: ApiSource,
): string[] {
	const prints = points.some((point) => point.status !== 'provisional');
	return [
		...(prints ? historyRequests(firstDay, historyTo, api) : []),
		...(points.some((point) => point.status === 'provisional') ? [api.current] : []),
	];
}

/**
 * The chart's ranges over `points`. Each ends on the newest point; All starts at the oldest.
 * `historyTo` is the last day the history requests cover (yesterday), so each range's source
 * links return exactly its prints.
 */
export function chartModel(
	points: readonly ChartPoint[],
	historyTo: UtcDate,
	api: ApiSource,
): ChartModel | null {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined) return null;
	const views = RANGE_IDS.map((id) => {
		const { label, days } = RANGE_SPECS[id];
		const firstDay = days === null ? first.day : last.day - days + 1;
		const inRange = points.filter((point) => point.day >= firstDay);
		return { id, label, firstDay, lastDay: last.day, points: inRange };
	});
	const ranges = views.map((view, index): RangeView => {
		const longer = views[index + 1];
		const sameAsLonger = longer !== undefined && longer.points.length === view.points.length;
		return {
			...view,
			disabledReason: sameAsLonger
				? `${view.label} shows the same ${view.points.length === 1 ? 'point' : `${view.points.length} points`} as ${longer.label}`
				: null,
			lines: linesOf(view.points),
			bands: bandsOf(view.points),
			sources: sourcesOf(view.points, view.firstDay, historyTo, api),
			summary: describeRange(view.points),
		};
	});
	const month = ranges.find((range) => range.id === '1M');
	return {
		ranges,
		initial: month !== undefined && month.disabledReason === null ? '1M' : 'all',
		headline: headlineOf(points),
		finalCount: points.filter((point) => point.status === 'final').length,
	};
}
