/**
 * What the data pages read, straight from the server read models the API serves. Pages render
 * per request so they are as fresh as the 5-minute collector; nothing here computes index values.
 */
import type { RoundReceipt, SettledStatus } from '@/lib/index/schemas';
import { FIRST_INDICATIVE_DAY, indicativeSeriesPublished } from '@/lib/index/indicative';
import { firstSettlementDay } from '@/lib/index/methodology';
import { addDays, utcDateOf } from '@/lib/index/time';
import { readHistory, readReceipt } from '@/server/archive';
import { storeFromEnv } from '@/server/storage';
import {
	API_BASE,
	currentView,
	HISTORY_MAX_DAYS,
	historyWindow,
	indicativeHistoryView,
} from '@/server/views';

import type { ApiSource } from './index-series';

export const RECENT_PRINT_DAYS = 14;

export type Current = Awaited<ReturnType<typeof currentView>>;
export type Provisional = Extract<Current, { status: 'provisional' }>;
export type Transition = Extract<Current, { status: 'transition' }>;
export type History = ReturnType<typeof historyWindow>;
export type HistoryDay = History['days'][number];
export type IndicativeHistory = Awaited<ReturnType<typeof indicativeHistoryView>>;
export type IndicativeDay = IndicativeHistory['days'][number];

/**
 * Today's running value, the history view of the last `RECENT_PRINT_DAYS` settled days, the
 * same days newest first, the home chart's history, and the frozen indicative ET days over the
 * recent span, newest first (null until the indicative series is published, so no page shows it
 * before its notice). The chart's history is every print through yesterday; its source links
 * chain `/api/v1/history` requests to cover it. Both history views come from one read of the
 * history index.
 */
export async function readSiteData(now: Date): Promise<{
	current: Current;
	history: History;
	recent: HistoryDay[];
	chartHistory: History;
	indicative: IndicativeHistory | null;
	recentIndicative: IndicativeDay[] | null;
}> {
	const store = storeFromEnv();
	const today = utcDateOf(now);
	const from = addDays(today, -RECENT_PRINT_DAYS);
	const yesterday = addDays(today, -1);
	const [current, historyIndex, indicative] = await Promise.all([
		currentView(store, now),
		readHistory(store, firstSettlementDay(), yesterday),
		indicativeSeriesPublished(now)
			? indicativeHistoryView(
					store,
					from > FIRST_INDICATIVE_DAY ? from : FIRST_INDICATIVE_DAY,
					yesterday,
				)
			: null,
	]);
	const history = historyWindow(historyIndex, from, yesterday);
	return {
		current,
		history,
		recent: [...history.days].reverse(),
		chartHistory: historyWindow(historyIndex, historyIndex.days[0]?.date ?? yesterday, yesterday),
		indicative,
		recentIndicative: indicative === null ? null : [...indicative.days].reverse(),
	};
}

/** Where the home chart's data comes from, so its source links are the real requests. */
export const CHART_API: ApiSource = {
	history: `${API_BASE}/history`,
	current: `${API_BASE}/current`,
	maxHistoryDays: HISTORY_MAX_DAYS,
};

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
