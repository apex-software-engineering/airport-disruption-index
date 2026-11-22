/**
 * What the data pages read, straight from the server read models the API serves. Pages render
 * per request so they are as fresh as the 5-minute collector; nothing here computes index values.
 */
import type { RoundReceipt, SettledStatus } from '@/lib/index/schemas';
import { FIRST_INDICATIVE_DAY, indicativeSeriesPublished } from '@/lib/index/indicative';
import { addDays, utcDateOf } from '@/lib/index/time';
import { readReceipt } from '@/server/archive';
import { storeFromEnv } from '@/server/storage';
import {
	API_BASE,
	currentView,
	HISTORY_MAX_DAYS,
	historyView,
	indicativeHistoryView,
} from '@/server/views';

export const RECENT_PRINT_DAYS = 14;

export type Current = Awaited<ReturnType<typeof currentView>>;
export type Provisional = Extract<Current, { status: 'provisional' }>;
export type Transition = Extract<Current, { status: 'transition' }>;
export type History = Awaited<ReturnType<typeof historyView>>;
export type HistoryDay = History['days'][number];
export type IndicativeHistory = Awaited<ReturnType<typeof indicativeHistoryView>>;
export type IndicativeDay = IndicativeHistory['days'][number];

/**
 * Today's running value, the history view of the last `RECENT_PRINT_DAYS` settled days, the
 * same days newest first, and the frozen indicative ET days over the same span, newest first
 * (null until the indicative series is published, so no page shows it before its notice).
 */
export async function readSiteData(now: Date): Promise<{
	current: Current;
	history: History;
	recent: HistoryDay[];
	indicative: IndicativeHistory | null;
	recentIndicative: IndicativeDay[] | null;
}> {
	const store = storeFromEnv();
	const today = utcDateOf(now);
	const from = addDays(today, -RECENT_PRINT_DAYS);
	const [current, history, indicative] = await Promise.all([
		currentView(store, now),
		historyView(store, from, addDays(today, -1)),
		indicativeSeriesPublished()
			? indicativeHistoryView(
					store,
					from > FIRST_INDICATIVE_DAY ? from : FIRST_INDICATIVE_DAY,
					addDays(today, -1),
				)
			: null,
	]);
	return {
		current,
		history,
		recent: [...history.days].reverse(),
		indicative,
		recentIndicative: indicative === null ? null : [...indicative.days].reverse(),
	};
}

/** Where the home chart's data comes from, so its source links are the real requests. */
export const CHART_ENDPOINTS = {
	history: `${API_BASE}/history`,
	current: `${API_BASE}/current`,
} as const;

/**
 * The home chart's prints: the longest span one `/api/v1/history` request returns, ending
 * yesterday, so a single public request rebuilds the whole chart.
 */
export async function readChartHistory(now: Date): Promise<History> {
	const to = addDays(utcDateOf(now), -1);
	return historyView(storeFromEnv(), addDays(to, 1 - HISTORY_MAX_DAYS), to);
}

/** The receipt behind `current.lastRound`, or null when no round has been recorded today. */
export async function readLastReceipt(current: Current): Promise<RoundReceipt | null> {
	if (current.lastRound === null) return null;
	const receipt = await readReceipt(storeFromEnv(), current.lastRound.roundId);
	if (receipt === null)
		throw new Error(`round ${current.lastRound.roundId} is indexed but has no receipt`);
	return receipt;
}

/** A running value means something only once the day has at least one valid round. */
export function hasValidRound(current: Provisional): boolean {
	return current.coverage.validRounds > 0;
}

export const SETTLED_TONE: Record<SettledStatus, 'good' | 'warn' | 'bad'> = {
	final: 'good',
	degraded: 'warn',
	suspended: 'bad',
};
