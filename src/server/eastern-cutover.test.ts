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
import { GET as getDay } from '@/app/api/v1/days/[date]/route';
import { collectingRelease, dayAt, dayWindow, settlementDay } from '@/lib/index/calendar';
import { settlementReleaseFor } from '@/lib/index/methodology';
import { buildPrint, historyEntryOf } from '@/lib/index/print';
import { reproduce } from '@/lib/reproduce';
import { routeGet } from '@/test/api';
import { RELEASES } from '@/lib/index/releases';
import { addDays } from '@/lib/index/time';
import { collectAt as collectStoreRound } from '@/test/collect';

import {
	correctDay,
	misfiledPrints,
	readCorrectionPrints,
	readHistory,
	readPrints,
	settleDay,
} from './archive';
import { FileStore } from './storage';
import { correctionsView, currentView, dayView, historyView } from './views';

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

/** Collects one round fetched at `at` into this test's store. */
const collectAt = (at: string) => collectStoreRound(store, at);

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Rounds around ET day E ([05:00Z, next 05:00Z)): two outside it, three inside it. */
async function collectAroundE() {
	for (const at of [
		'2027-01-01T02:00:03Z', // the transition interval: outside every settlement day
		'2027-01-01T05:00:03Z', // E's first slot
		'2027-01-01T23:55:03Z', // the last slot in the first UTC partition
		'2027-01-02T04:55:03Z', // E's last slot, in the second UTC partition
		'2027-01-02T05:00:03Z', // the next ET day: outside
	]) {
		await collectAt(at);
	}
}

/** What a stale v1-only deployment would write for label E: a UTC-day print under v1's root. */
function staleV1Print(revision: 1 | 2) {
	const day = { release: v1Release(), window: dayWindow(v1Release(), E) };
	return revision === 1
		? buildPrint(day, [], { revision: 1 })
		: buildPrint(day, [], {
				revision: 2,
				correction: {
					supersedesPrintHash: '0'.repeat(64),
					reason: 'stale',
					issuedAt: '2027-01-02T01:00:00.000Z',
					windowOverride: null,
				},
			});
}

describe('settlement labels across the cutover', () => {
	it('builds a /1 UTC print for every label up to E−1 and a /2 ET print from E', () => {
		for (let offset = -3; offset <= 3; offset += 1) {
			const label = addDays(E, offset);
			const print = buildPrint(settlementDay(label), [], { revision: 1 });
			if (offset < 0) {
				expect(print).toMatchObject({ schema: 'adi.daily-print/1', methodologyVersion: '1.0.0' });
				expect(print).not.toHaveProperty('window');
			} else {
				expect(print).toMatchObject({
					schema: 'adi.daily-print/2',
					standing: 'settlement',
					day: 'America/New_York',
					methodologyVersion: '2.0.0',
					window: {
						start: dayWindow(settlementReleaseFor(label), label).start.toISOString(),
						end: dayWindow(settlementReleaseFor(label), label).end.toISOString(),
					},
				});
			}
		}
	});

	it('settles ET day E from both UTC partitions under v2, at its own keys', async () => {
		await collectAroundE();
		const indexBefore = await store.read(`days/${E}.json`);
		const { status, print } = await settleDay(store, E);
		expect(status).toBe('settled');
		expect(print).toMatchObject({
			schema: 'adi.daily-print/2',
			date: E,
			window: { start: '2027-01-01T05:00:00.000Z', end: '2027-01-02T05:00:00.000Z' },
			settlesAt: '2027-01-02T05:30:00.000Z',
			methodologyVersion: '2.0.0',
			coverage: { slotsPerDay: 288, validRounds: 3 },
		});
		expect(print.rounds.map((r) => r.roundId)).toEqual([
			'2027-01-01T05:00Z',
			'2027-01-01T23:55Z',
			'2027-01-02T04:55Z',
		]);
		expect(await store.list(`prints/et/${E}/`)).toEqual([`prints/et/${E}/r1.json`]);
		expect(await store.list(`prints/${E}/`)).toEqual([]);
		// A partition's index stays owned by collect: an ET settle never rewrites it.
		expect((await store.read(`days/${E}.json`))?.body).toEqual(indexBefore?.body);
		expect((await readHistory(store)).days.map((d) => [d.date, d.revision])).toEqual([[E, 1]]);
		expect(await store.list('prints/et/history.json')).toEqual(['prints/et/history.json']);
		// reproduce rebuilds it from the public API.
		expect(await reproduce(E, 'http://test', routeGet)).toMatchObject({ kind: 'match' });
		// History lists both releases' days, each with its own zone and window.
		await settleDay(store, '2026-12-31');
		const history = await historyView(store, '2026-12-31', E);
		expect(history.days.map((d) => [d.date, d.methodologyVersion, d.day, d.window.start])).toEqual([
			['2026-12-31', '1.0.0', 'UTC', '2026-12-31T00:00:00.000Z'],
			[E, '2.0.0', 'America/New_York', '2027-01-01T05:00:00.000Z'],
		]);
	});

	it('corrects an ET day into its own root and history', async () => {
		await collectAroundE();
		const { print } = await settleDay(store, E);
		const corrected = await correctDay(
			store,
			E,
			{ supersedesPrintHash: print.printHash, reason: 'test', windowOverride: null },
			() => new Date('2027-01-02T12:00:00Z'),
		);
		expect(corrected).toMatchObject({ schema: 'adi.daily-print/2', revision: 2 });
		expect(await store.list(`prints/et/${E}/`)).toEqual([
			`prints/et/${E}/r1.json`,
			`prints/et/${E}/r2.json`,
		]);
		expect((await readHistory(store)).days).toEqual([
			expect.objectContaining({ date: E, revision: 2 }),
		]);
	});

	it('never serves a stale v1 print, history entry or correction for a label from E, even before repair', async () => {
		const r1 = staleV1Print(1);
		const r2 = staleV1Print(2);
		await store.write(`prints/${E}/r1.json`, encode(r1), 'application/json', { kind: 'if-absent' });
		await store.write(`prints/${E}/r2.json`, encode(r2), 'application/json', { kind: 'if-absent' });
		await store.write(
			'prints/history.json',
			encode({ schema: 'adi.history/1', days: [historyEntryOf(r2)] }),
			'application/json',
			{ kind: 'if-absent' },
		);
		// Immediately, with no settle run: nothing stale is served, and it is reported.
		expect(await dayView(store, E)).toMatchObject({
			status: 'unsettled',
			misfiled: {
				problem: 'misfiled_print',
				objects: [`prints/${E}/r1.json`, `prints/${E}/r2.json`, 'prints/history.json'],
			},
		});
		expect((await readHistory(store)).days).toEqual([]);
		expect(await correctionsView(store)).toEqual([]);
		// The v2 settle is unaffected, and the settle route still reports the stale objects.
		await collectAroundE();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2027-01-02T05:30:00Z'));
		const response = await settleRoute(
			new Request(`http://test/api/cron/settle?date=${E}`, {
				headers: { authorization: 'Bearer test-cron-secret' },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'settled',
			misfiled: {
				problem: 'misfiled_print',
				objects: [`prints/${E}/r1.json`, `prints/${E}/r2.json`, 'prints/history.json'],
			},
		});
		expect(await dayView(store, E)).toMatchObject({
			status: 'settled',
			print: { schema: 'adi.daily-print/2', methodologyVersion: '2.0.0' },
		});
		expect((await readHistory(store)).days.map((d) => d.date)).toEqual([E]);
	});

	it('applies one key contract: date, revision and owning release, wherever a print is read', async () => {
		// A valid ET print of 2027-01-02, stored at 2027-01-01's key: the day reader refuses it.
		const nextDay = buildPrint(settlementDay('2027-01-02'), [], { revision: 1 });
		await store.write(`prints/et/${E}/r1.json`, encode(nextDay), 'application/json', {
			kind: 'if-absent',
		});
		await expect(readPrints(store, E)).rejects.toThrow(
			`prints/et/${E}/r1.json holds revision 1 of 2027-01-02`,
		);
		// A valid v1 correction under the ET root: never listed, and reported.
		await store.write(`prints/et/${E}/r2.json`, encode(staleV1Print(2)), 'application/json', {
			kind: 'if-absent',
		});
		expect(await readCorrectionPrints(store)).toEqual([]);
		expect(await misfiledPrints(store, E)).toEqual({
			problem: 'misfiled_print',
			objects: [`prints/et/${E}/r1.json`, `prints/et/${E}/r2.json`],
		});
	});

	it('reports a prints/et object under a v1 label, which no v1 reader serves', async () => {
		const v1Day = '2026-12-31';
		const zoned = buildPrint(settlementDay(E), [], { revision: 1 });
		await store.write(`prints/et/${v1Day}/r1.json`, encode(zoned), 'application/json', {
			kind: 'if-absent',
		});
		expect(await dayView(store, v1Day)).toMatchObject({
			status: 'unsettled',
			day: 'UTC',
			misfiled: { problem: 'misfiled_print', objects: [`prints/et/${v1Day}/r1.json`] },
		});
		expect(await readPrints(store, v1Day)).toEqual([]);
	});

	it('reports a stale history entry even when it is the only stale record', async () => {
		await store.write(
			'prints/history.json',
			encode({ schema: 'adi.history/1', days: [historyEntryOf(staleV1Print(1))] }),
			'application/json',
			{ kind: 'if-absent' },
		);
		const misfiled = { problem: 'misfiled_print', objects: ['prints/history.json'] };
		expect((await readHistory(store)).days).toEqual([]);
		expect(await dayView(store, E)).toMatchObject({ status: 'unsettled', misfiled });
		await collectAroundE();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2027-01-02T05:30:00Z'));
		const response = await settleRoute(
			new Request(`http://test/api/cron/settle?date=${E}`, {
				headers: { authorization: 'Bearer test-cron-secret' },
			}),
		);
		expect(await response.json()).toMatchObject({ status: 'settled', misfiled });
	});

	it('reads only in-window receipts and writes only its own root when settling and correcting', async () => {
		await collectAroundE();
		// Corrupt receipts just outside the window, on both sides: never read, so never fatal.
		for (const key of [
			'rounds/2027-01-01/2027-01-01T04:55Z.json',
			'rounds/2027-01-02/2027-01-02T05:05Z.json',
		]) {
			await store.write(key, new TextEncoder().encode('not json'), 'application/json', {
				kind: 'if-absent',
			});
		}
		const calls: string[] = [];
		const recording = new (class extends FileStore {
			override read(key: string) {
				calls.push(`read ${key}`);
				return super.read(key);
			}
			override write(...args: Parameters<FileStore['write']>) {
				calls.push(`write ${args[0]}`);
				return super.write(...args);
			}
		})(root);
		const { print } = await settleDay(recording, E);
		const corrected = await correctDay(
			recording,
			E,
			{ supersedesPrintHash: print.printHash, reason: 'test', windowOverride: null },
			() => new Date('2027-01-02T12:00:00Z'),
		);
		expect(corrected.revision).toBe(2);
		const receiptReads = calls.filter((c) => c.startsWith('read rounds/'));
		expect(new Set(receiptReads)).toEqual(
			new Set([
				'read rounds/2027-01-01/2027-01-01T05:00Z.json',
				'read rounds/2027-01-01/2027-01-01T23:55Z.json',
				'read rounds/2027-01-02/2027-01-02T04:55Z.json',
			]),
		);
		expect(calls.filter((c) => c.startsWith('write '))).toEqual([
			`write prints/et/${E}/r1.json`,
			'write prints/et/history.json',
			`write prints/et/${E}/r2.json`,
			'write prints/et/history.json',
		]);
		expect(calls.some((c) => c.includes(' days/'))).toBe(false);
	});

	it('states each day’s envelope: v2 deadlines and window for E, v1’s for E−1', async () => {
		expect(await dayView(store, E)).toEqual({
			date: E,
			standing: 'settlement',
			methodologyVersion: '2.0.0',
			day: 'America/New_York',
			window: { start: '2027-01-01T05:00:00.000Z', end: '2027-01-02T05:00:00.000Z' },
			status: 'unsettled',
			settlesAt: '2027-01-02T05:30:00.000Z',
			publishBy: '2027-01-02T06:30:00.000Z',
		});
		expect(await dayView(store, '2026-12-31')).toMatchObject({
			day: 'UTC',
			window: { start: '2026-12-31T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
			settlesAt: '2027-01-01T00:30:00.000Z',
			publishBy: '2027-01-01T01:30:00.000Z',
		});
	});

	it('answers a pinned parameter hash that does not own the day with parameter_hash_mismatch', async () => {
		const get = (query: string) =>
			getDay(new Request(`http://test/api/v1/days/${E}${query}`), {
				params: Promise.resolve({ date: E }),
			});
		const v1 = v1Release();
		const v2 = settlementReleaseFor(E);
		const mismatch = await get(`?parameterHash=${v1.parameterHash}`);
		expect(mismatch.status).toBe(404);
		expect(await mismatch.json()).toEqual({
			problem: 'parameter_hash_mismatch',
			date: E,
			expected: v1.parameterHash,
			actual: v2.parameterHash,
			release: {
				version: '2.0.0',
				parameterHash: v2.parameterHash,
				effectiveFrom: E,
				effectiveUntil: null,
			},
		});
		// The right hash answers as without the parameter (unsettled here).
		expect(await (await get(`?parameterHash=${v2.parameterHash}`)).json()).toMatchObject({
			status: 'unsettled',
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
