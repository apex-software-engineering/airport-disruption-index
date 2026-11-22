/**
 * The v1 → v2 cutover once activated (step 2 of the design): v1 ends with UTC day 2026-12-31, v2
 * takes effect at 2027-01-01T00:00Z, and its first ET day starts at 05:00Z. The five hours between
 * belong to no settlement day. The registry is the only thing mocked.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as settleRoute } from '@/app/api/cron/settle/route';
import { collectingRelease, dayAt, dayWindow, settlementDay } from '@/lib/index/calendar';
import { settlementReleaseFor } from '@/lib/index/methodology';
import { buildPrint } from '@/lib/index/print';
import { RELEASES } from '@/lib/index/releases';
import { addDays } from '@/lib/index/time';
import { feedFixtureText } from '@/test/fixtures';

import { correctDay, readHistory, settleDay } from './archive';
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
	vi.stubEnv('ADI_DATA_DIR', root);
	vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** The v1 release of the mocked registry, as a stale v1-only deployment would use it. */
function v1Release() {
	const v1 = RELEASES[0];
	if (v1 === undefined) throw new Error('the mocked registry lists v1');
	return v1;
}

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
			const day = settlementDay(label);
			if (offset < 0) {
				expect(day.release.parameters.version).toBe('1.0.0');
				expect(buildPrint(day, [], { revision: 1 }).methodologyVersion).toBe('1.0.0');
			} else {
				// A v2 day can be built only as an adi.daily-print/2 print, which arrives later.
				expect(settlementReleaseFor(label).parameters.version).toBe('2.0.0');
				expect(() => buildPrint(day, [], { revision: 1 })).toThrow(/UTC days only/);
			}
		}
	});

	it('never moves a stale v1 print for a label from E into the history index', async () => {
		// A v1-only deployment settling 2027-01-01 as a UTC day left this print behind.
		const stale = buildPrint({ release: v1Release(), window: dayWindow(v1Release(), E) }, [], {
			revision: 1,
		});
		const key = `prints/${E}/r1.json`;
		await store.write(key, new TextEncoder().encode(JSON.stringify(stale)), 'application/json', {
			kind: 'if-absent',
		});
		await expect(settleDay(store, E)).rejects.toThrow(/only a UTC day can be settled here/);
		expect((await readHistory(store)).days).toEqual([]);
	});

	it('answers a zoned ?date on the settle route with a structured 409, not a 500', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2027-01-03T00:00:00Z'));
		const response = await settleRoute(
			new Request(`http://test/api/cron/settle?date=${E}`, {
				headers: { authorization: 'Bearer test-cron-secret' },
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: `${E} is an America/New_York day; settling those days is not available yet`,
		});
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
				window: { start: '2026-12-31T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
			},
			nextDay: {
				date: E,
				window: { start: '2027-01-01T05:00:00.000Z', end: '2027-01-02T05:00:00.000Z' },
			},
			lastRound: expect.objectContaining({ roundId: '2027-01-01T02:00Z', status: 'valid' }),
		});
	});

	it('keeps the heartbeat at 00:00Z, from the previous UTC partition until a round arrives', async () => {
		await collectAt('2026-12-31T23:55:03Z');
		const current = await currentView(store, new Date('2027-01-01T00:00:30Z'));
		expect(current).toMatchObject({
			status: 'transition',
			lastRound: { roundId: '2026-12-31T23:55Z', status: 'valid' },
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
