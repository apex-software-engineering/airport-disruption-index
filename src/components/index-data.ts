/**
 * What the data pages read, straight from the server read models the API serves. Pages render
 * per request so they are as fresh as the 5-minute collector; nothing here computes index values.
 */
import type { RoundReceipt, SettledStatus } from '@/lib/index/schemas';
import { addDays, utcDateOf } from '@/lib/index/time';
import { readReceipt } from '@/server/archive';
import { storeFromEnv } from '@/server/storage';
import { currentView, historyView } from '@/server/views';

export const RECENT_PRINT_DAYS = 14;

export type Current = Awaited<ReturnType<typeof currentView>>;
export type Provisional = Extract<Current, { status: 'provisional' }>;
export type Transition = Extract<Current, { status: 'transition' }>;
export type History = Awaited<ReturnType<typeof historyView>>;
export type HistoryDay = History['days'][number];

/**
 * Today's running value, the history view of the last `RECENT_PRINT_DAYS` settled days, and the
 * same days newest first.
 */
export async function readSiteData(
	now: Date,
): Promise<{ current: Current; history: History; recent: HistoryDay[] }> {
	const store = storeFromEnv();
	const today = utcDateOf(now);
	const [current, history] = await Promise.all([
		currentView(store, now),
		historyView(store, addDays(today, -RECENT_PRINT_DAYS), addDays(today, -1)),
	]);
	return { current, history, recent: [...history.days].reverse() };
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
