/**
 * The v1 → v2 cutover once activated (step 2 of the design): v1 ends with UTC day 2026-12-31, v2
 * takes effect at 2027-01-01T00:00Z, and its first ET day starts at 05:00Z. The five hours between
 * belong to no settlement day. The registry is the only thing mocked.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectingRelease, dayAt, settlementDay } from '@/lib/index/calendar';
import { settlementReleaseFor } from '@/lib/index/methodology';
import { buildPrint } from '@/lib/index/print';
import { addDays } from '@/lib/index/time';
import { feedFixtureText } from '@/test/fixtures';

import { correctDay, settleDay } from './archive';
import { collectRound } from './collector';
import { FileStore } from './storage';
import { currentView, dayView } from './views';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17', { effectiveUntil: '2026-12-31' }),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', {
				announcedAt: '2026-11-25T15:00:00.000Z',
				announcedProofAt: '2026-11-25T16:00:00.000Z',
			}),
		],
	};
});

const E = '2027-01-01';

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-eastern-'));
	store = new FileStore(root);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Collects one all-clear round fetched at `at`, as the deployed collector would. */
function collectAt(at: string) {
	const fetchedAt = new Date(at);
	const stamp = new Date(fetchedAt.getTime() - 60_000)
		.toUTCString()
		.replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/, '$1 $3 $2 $5 $4 GMT');
	const xml = feedFixtureText('synthetic-gs-gdp.xml').replace(
		'Tue Nov 17 20:43:54 2026 GMT',
		stamp,
	);
	return collectRound(
		store,
		async () => ({
			fetchedAt,
			outcome: { kind: 'response', httpStatus: 200, body: new TextEncoder().encode(xml) },
		}),
		() => new Date(fetchedAt.getTime() + 1000),
	);
}

describe('settlement labels across the cutover', () => {
	it('gives every label up to E−1 to v1 and every label from E to v2, on every settlement path', () => {
		for (let offset = -3; offset <= 3; offset += 1) {
			const label = addDays(E, offset);
			const expected = offset < 0 ? '1.0.0' : '2.0.0';
			expect(settlementReleaseFor(label).parameters.version).toBe(expected);
			const print = buildPrint(settlementDay(label), [], { revision: 1 });
			expect(print.methodologyVersion).toBe(expected);
		}
	});

	it('can never write a v1 print for a label from E: settling or correcting one is refused', async () => {
		await expect(settleDay(store, E)).rejects.toThrow(/only a UTC day can be settled here/);
		await expect(
			correctDay(
				store,
				E,
				{ supersedesPrintHash: '0'.repeat(64), reason: 'test', windowOverride: null },
				() => new Date('2027-01-02T12:00:00Z'),
			),
		).rejects.toThrow(/has not settled/);
		expect((await dayView(store, E)).status).toBe('unsettled');
	});

	it('states the v2 deadlines for E and the v1 deadlines for E−1', async () => {
		expect(await dayView(store, E)).toEqual({
			date: E,
			status: 'unsettled',
			settlesAt: '2027-01-02T05:30:00.000Z',
			publishBy: '2027-01-02T06:30:00.000Z',
		});
		expect(await dayView(store, '2026-12-31')).toMatchObject({
			settlesAt: '2027-01-01T00:30:00.000Z',
			publishBy: '2027-01-01T01:30:00.000Z',
		});
	});
});

describe('instants across the cutover', () => {
	it.each([
		['2026-12-31T23:59:59Z', 'day', '2026-12-31'],
		['2027-01-01T00:00:00Z', 'transition', null],
		['2027-01-01T04:59:59Z', 'transition', null],
		['2027-01-01T05:00:00Z', 'day', E],
	])('puts %s in a %s', (at, kind, date) => {
		const result = dayAt(new Date(at));
		expect(result.kind).toBe(kind);
		if (result.kind === 'day') expect(result.window.date).toBe(date);
		else {
			expect(result.previous.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
			expect(result.next.start.toISOString()).toBe('2027-01-01T05:00:00.000Z');
		}
	});

	it('collects under v1 until 00:00Z and under v2 from then, through the transition', () => {
		expect(collectingRelease(new Date('2026-12-31T23:59:59Z')).parameters.version).toBe('1.0.0');
		expect(collectingRelease(new Date('2027-01-01T00:00:00Z')).parameters.version).toBe('2.0.0');
		expect(collectingRelease(new Date('2027-01-01T02:00:00Z')).parameters.version).toBe('2.0.0');
	});
});

describe('the running value across the cutover', () => {
	it('reports the transition, with the heartbeat, between the two releases’ days', async () => {
		const { receipt } = await collectAt('2027-01-01T02:00:03Z');
		expect(receipt.methodologyVersion).toBe('2.0.0');
		expect(await currentView(store, new Date('2027-01-01T02:01:00Z'))).toEqual({
			status: 'transition',
			asOf: '2027-01-01T02:01:00.000Z',
			previousDay: {
				date: '2026-12-31',
				settlesAt: '2027-01-01T00:30:00.000Z',
				publishBy: '2027-01-01T01:30:00.000Z',
			},
			nextDay: { date: E, startsAt: '2027-01-01T05:00:00.000Z' },
			lastRound: expect.objectContaining({ roundId: '2027-01-01T02:00Z', status: 'valid' }),
		});
	});

	it('runs the first ET day from 05:00Z, leaving the transition’s rounds out of it', async () => {
		await collectAt('2027-01-01T02:00:03Z');
		await collectAt('2027-01-01T05:00:03Z');
		const current = await currentView(store, new Date('2027-01-01T05:06:00Z'));
		if (current.status !== 'provisional')
			throw new Error(`expected provisional, got ${current.status}`);
		expect(current).toMatchObject({
			date: E,
			settlesAt: '2027-01-02T05:30:00.000Z',
			publishBy: '2027-01-02T06:30:00.000Z',
			methodologyVersion: '2.0.0',
			coverage: { slotsPerDay: 288, validRounds: 1, elapsedSlots: 1 },
		});
		expect(current.hourly[0]?.hourStart).toBe('2027-01-01T05:00:00.000Z');
		expect(current.lastRound?.roundId).toBe('2027-01-01T05:00Z');
	});

	it('runs the last UTC day under v1 until 00:00Z', async () => {
		await collectAt('2026-12-31T23:55:03Z');
		const current = await currentView(store, new Date('2026-12-31T23:59:00Z'));
		expect(current).toMatchObject({
			status: 'provisional',
			date: '2026-12-31',
			methodologyVersion: '1.0.0',
			coverage: { slotsPerDay: 288, validRounds: 1 },
		});
	});
});
