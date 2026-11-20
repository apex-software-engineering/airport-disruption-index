import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { feedFixture } from '@/test/fixtures';

import { readDayIndex, readPrints, readRaw, readReceipt, settleDay } from './archive';
import { collectRound, type FeedFetcher } from './collector';
import { FileStore } from './storage';
import { currentView, dayView, historyView } from './views';

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-'));
	store = new FileStore(root);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A fetcher answering with `fixture` (Update_Time 20:43:54Z) at `fetchedAt`. */
function fixtureAt(
	fetchedAt: string,
	fixture = 'synthetic-gs-gdp.xml',
	httpStatus = 200,
): FeedFetcher {
	return async () => ({
		fetchedAt: new Date(fetchedAt),
		outcome: { kind: 'response', httpStatus, body: feedFixture(fixture) },
	});
}

describe('collectRound', () => {
	it('archives the receipt, the raw body and a day index entry', async () => {
		const { outcome, receipt } = await collectRound(store, fixtureAt('2026-11-17T20:45:03Z'));
		expect(outcome).toBe('recorded');
		expect(await readReceipt(store, '2026-11-17T20:45Z')).toEqual(receipt);
		expect(await readRaw(store, receipt)).toEqual(feedFixture('synthetic-gs-gdp.xml'));
		const index = await readDayIndex(store, '2026-11-17');
		expect(index.rounds.map((r) => r.roundId)).toEqual(['2026-11-17T20:45Z']);
	});

	it('is idempotent within a slot: the first valid round wins', async () => {
		const first = await collectRound(store, fixtureAt('2026-11-17T20:45:03Z'));
		const second = await collectRound(
			store,
			fixtureAt('2026-11-17T20:46:00Z', 'live-2026-11-17T20-43-56Z.xml'),
		);
		expect(second.outcome).toBe('duplicate');
		expect(second.receipt).toEqual(first.receipt);
		expect((await readReceipt(store, '2026-11-17T20:45Z'))?.receiptHash).toBe(
			first.receipt.receiptHash,
		);
		expect((await readDayIndex(store, '2026-11-17')).rounds).toHaveLength(1);
	});

	it('lets a valid round replace an invalid one in the same slot, but not the reverse', async () => {
		expect(
			(await collectRound(store, fixtureAt('2026-11-17T20:45:01Z', 'synthetic-gs-gdp.xml', 503)))
				.outcome,
		).toBe('recorded');
		expect(
			(await collectRound(store, fixtureAt('2026-11-17T20:45:30Z', 'synthetic-gs-gdp.xml', 502)))
				.outcome,
		).toBe('duplicate');
		expect((await readReceipt(store, '2026-11-17T20:45Z'))?.httpStatus).toBe(503);
		expect((await collectRound(store, fixtureAt('2026-11-17T20:46:00Z'))).outcome).toBe(
			'superseded_invalid',
		);
		const index = await readDayIndex(store, '2026-11-17');
		expect(index.rounds.map((r) => r.observation.status)).toEqual(['valid']);
	});

	it('records a network failure without a raw body', async () => {
		const failing: FeedFetcher = async () => ({
			fetchedAt: new Date('2026-11-17T20:50:02Z'),
			outcome: { kind: 'network_error', detail: 'TimeoutError: timed out' },
		});
		const { receipt } = await collectRound(store, failing);
		expect(receipt.observation).toMatchObject({ status: 'invalid', reason: 'network_error' });
		expect(await readRaw(store, receipt)).toBeNull();
	});
});

describe('views and settlement', () => {
	it('serves the running value and settles a day once', async () => {
		await collectRound(store, fixtureAt('2026-11-17T20:45:03Z'));
		await collectRound(store, fixtureAt('2026-11-17T20:50:03Z'));
		const current = await currentView(store, new Date('2026-11-17T20:56:00Z'));
		// LGA (GS+GDP) and SFO (GDP) in the 20:45 and 20:50 slots; 20:55 has not ended, so it is pending.
		expect(current).toMatchObject({
			date: '2026-11-17',
			status: 'provisional',
			value: 20,
			groundStopValue: 10,
		});
		expect(current.lastRound).toMatchObject({
			roundId: '2026-11-17T20:50Z',
			url: '/api/v1/rounds/2026-11-17T20:50Z',
		});
		expect(current.latestSlot).toMatchObject({ status: 'observed', roundId: '2026-11-17T20:50Z' });

		expect(await dayView(store, '2026-11-17')).toMatchObject({ status: 'unsettled' });
		const settled = await settleDay(store, '2026-11-17');
		expect(settled.status).toBe('settled');
		expect(settled.print.result).toEqual({
			status: 'suspended',
			reason: 'coverage 2/288 valid rounds is below 80%',
		});
		expect(settled.print.rounds).toHaveLength(2);
		const again = await settleDay(store, '2026-11-17');
		expect(again).toEqual({ status: 'already_settled', print: settled.print });
		expect(await readPrints(store, '2026-11-17')).toHaveLength(1);
		expect(await historyView(store, '2026-11-01', '2026-11-30')).toMatchObject({
			days: [
				{ date: '2026-11-17', status: 'suspended', value: null, url: '/api/v1/days/2026-11-17' },
			],
		});
	});
});
