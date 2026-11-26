/**
 * The fixture stores the home chart is checked against: filesystem stores (ADI_DATA_DIR) holding
 * only a history index, dated relative to the day the suite runs. With no rounds stored, today
 * has no running value, so each scenario is exactly its prints.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { HistoryEntry, SettledStatus } from '@/lib/index/schemas';
import { addDays, utcDateOf, type UtcDate } from '@/lib/index/time';

const ROOT = path.resolve(__dirname, '../../test-results/fixture-stores');

export type Scenario = { name: string; port: number; dir: string; baseURL: string };

function scenario(name: string, port: number): Scenario {
	return { name, port, dir: path.join(ROOT, name), baseURL: `http://localhost:${port}` };
}

export const SUSPENDED_ONLY = scenario('suspended-only', 3561);
export const LONG_HISTORY = scenario('long-history', 3562);
export const SCENARIOS = [SUSPENDED_ONLY, LONG_HISTORY] as const;

function entry(date: UtcDate, status: SettledStatus, value: number | null): HistoryEntry {
	return {
		date,
		revision: 1,
		status,
		value,
		groundStopValue: value === null ? null : Math.floor(value / 4),
		coveragePercent: status === 'final' ? 100 : status === 'degraded' ? 81.25 : 12.5,
		printHash: date.replaceAll('-', '').padEnd(64, 'a'),
	};
}

export const yesterday = (): UtcDate => addDays(utcDateOf(new Date()), -1);

/** Two suspended days ending yesterday: no day has a value. */
export function suspendedOnlyPrints(): HistoryEntry[] {
	return [
		entry(addDays(yesterday(), -1), 'suspended', null),
		entry(yesterday(), 'suspended', null),
	];
}

/** Days back from yesterday that the long history leaves without a print. */
export const MISSING_DAYS_AGO = [5, 40];
/** Days back from yesterday that are suspended: one run of three, then a single day. */
export const SUSPENDED_DAYS_AGO = [20, 21, 22, 60];
/** More days than one history request returns, so All needs two requests. */
export const LONG_HISTORY_DAYS = 400;

/** 400 days ending yesterday: finals, some degraded, two suspended stretches and missing days. */
export function longHistoryPrints(): HistoryEntry[] {
	const prints: HistoryEntry[] = [];
	for (let ago = LONG_HISTORY_DAYS - 1; ago >= 0; ago--) {
		if (MISSING_DAYS_AGO.includes(ago)) continue;
		const date = addDays(yesterday(), -ago);
		if (SUSPENDED_DAYS_AGO.includes(ago)) prints.push(entry(date, 'suspended', null));
		else prints.push(entry(date, ago % 13 === 3 ? 'degraded' : 'final', 200 + ((ago * 37) % 900)));
	}
	return prints;
}

async function writeStore(dir: string, days: readonly HistoryEntry[]): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(path.join(dir, 'prints'), { recursive: true });
	await writeFile(
		path.join(dir, 'prints/history.json'),
		JSON.stringify({ schema: 'adi.history/1', days }),
	);
}

/** Playwright global setup: the servers read the stores per request, so writing them now is enough. */
export default async function writeStores(): Promise<void> {
	await writeStore(SUSPENDED_ONLY.dir, suspendedOnlyPrints());
	await writeStore(LONG_HISTORY.dir, longHistoryPrints());
}
