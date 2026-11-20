/**
 * What the data pages read, straight from the server read models the API serves. Pages render
 * per request so they are as fresh as the 5-minute collector; nothing here computes index values.
 */
import type { SettledStatus } from '@/lib/index/schemas';
import { addDays, utcDateOf } from '@/lib/index/time';
import { storeFromEnv } from '@/server/storage';
import { currentView, historyView } from '@/server/views';

export const RECENT_PRINT_DAYS = 14;

export type Current = Awaited<ReturnType<typeof currentView>>;
export type History = Awaited<ReturnType<typeof historyView>>;
export type HistoryDay = History['days'][number];

/** Today's running value and the settled days of the last `RECENT_PRINT_DAYS`, newest first. */
export async function readSiteData(now: Date): Promise<{ current: Current; recent: HistoryDay[] }> {
	const store = storeFromEnv();
	const today = utcDateOf(now);
	const [current, history] = await Promise.all([
		currentView(store, now),
		historyView(store, addDays(today, -RECENT_PRINT_DAYS), addDays(today, -1)),
	]);
	return { current, recent: [...history.days].reverse() };
}

/** A running value means something only once the day has at least one valid round. */
export function hasValidRound(current: Current): boolean {
	return current.coverage.validRounds > 0;
}

export const SETTLED_TONE: Record<SettledStatus, 'good' | 'warn' | 'bad'> = {
	final: 'good',
	degraded: 'warn',
	suspended: 'bad',
};
