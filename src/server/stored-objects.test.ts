/**
 * Stored content this code did not just write never breaks a read (Sol r3 on #31): print and
 * history objects are classified, misfiled ones are reported, and receipts are bound to their key.
 * Runs the activated registry: v1 through 2026-12-31, v2 (ET days) from E = 2027-01-01.
 */
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as settleRoute } from '@/app/api/cron/settle/route';
import { dayWindow, settlementDay } from '@/lib/index/calendar';
import { indicativeAdmissionFor } from '@/lib/index/indicative';
import { buildIndicativePrint, buildPrint } from '@/lib/index/print';
import { RELEASES } from '@/lib/index/releases';
import { routeGet } from '@/test/api';
import { collectAt as collectStoreRound } from '@/test/collect';

import { FileStore } from './storage';
import { correctionsView } from './views';

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
const V1_DAY = '2026-12-31';
const GARBAGE = new TextEncoder().encode('{"not": "a print"');

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-stored-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
	vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const put = (key: string, body: Uint8Array) =>
	store.write(key, body, 'application/json', { kind: 'if-absent' });
const collectAt = (at: string) => collectStoreRound(store, at);

async function settle(date: string, at: string) {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(at));
	const response = await settleRoute(
		new Request(`http://test/api/cron/settle?date=${date}`, {
			headers: { authorization: 'Bearer test-cron-secret' },
		}),
	);
	vi.useRealTimers();
	return response;
}

const get = (pathAndQuery: string) => routeGet(`http://test${pathAndQuery}`);

/** A valid ET print of the day after E: a print, but not E's. */
const nextDayPrint = () => buildPrint(settlementDay('2027-01-02'), [], { revision: 1 });

describe('settle classifies the occupied r1 key before reading anything else (finding 1)', () => {
	it('answers 409 blocked with a corrupt in-window receipt, never reading it', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		await put('rounds/2027-01-01/2027-01-01T06:00Z.json', GARBAGE);
		await put(`prints/et/${E}/r1.json`, encode(nextDayPrint()));
		const response = await settle(E, '2027-01-02T05:30:00Z');
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			status: 'blocked',
			date: E,
			misfiled: { problem: 'misfiled_print', objects: [`prints/et/${E}/r1.json`] },
			indicative: [],
		});
	});

	it('leaves a v1 day index and the conflicting r1 untouched', async () => {
		await collectAt('2026-12-31T10:00:03Z');
		const misfiled = encode(nextDayPrint());
		await put(`prints/${V1_DAY}/r1.json`, misfiled);
		// The route opens its own store, so every store's writes are watched.
		const write = vi.spyOn(FileStore.prototype, 'write');
		const response = await settle(V1_DAY, '2027-01-01T00:30:00Z');
		expect(response.status).toBe(409);
		expect(write).not.toHaveBeenCalled();
		write.mockRestore();
		expect((await store.read(`prints/${V1_DAY}/r1.json`))?.body).toEqual(misfiled);
	});
});

describe('a canonical print key holding a non-print never breaks a read (finding 2)', () => {
	it('reports malformed JSON at r1 from /days and settle', async () => {
		await put(`prints/et/${E}/r1.json`, GARBAGE);
		const day = await get(`/api/v1/days/${E}`);
		expect(day.status).toBe(404);
		expect(await day.json()).toMatchObject({
			status: 'unsettled',
			misfiled: { problem: 'misfiled_print', objects: [`prints/et/${E}/r1.json`] },
		});
		expect((await settle(E, '2027-01-02T05:30:00Z')).status).toBe(409);
		expect((await store.read(`prints/et/${E}/r1.json`))?.body).toEqual(GARBAGE);
	});

	it('reports an indicative print at r1 instead of serving it', async () => {
		const v2 = RELEASES[1];
		const admission = v2 === undefined ? null : indicativeAdmissionFor(v2);
		if (v2 === undefined || admission === null) throw new Error('the mocked registry lists v2');
		const indicative = buildIndicativePrint(
			{ release: v2, window: dayWindow(v2, E) },
			[],
			admission,
		);
		await put(`prints/et/${E}/r1.json`, encode(indicative));
		const day = await get(`/api/v1/days/${E}`);
		expect(day.status).toBe(404);
		expect(await day.json()).toMatchObject({
			status: 'unsettled',
			misfiled: { objects: [`prints/et/${E}/r1.json`] },
		});
	});

	it('serves the last valid revision past a malformed r2, which /incidents never lists', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		expect((await settle(E, '2027-01-02T05:30:00Z')).status).toBe(200);
		await put(`prints/et/${E}/r2.json`, GARBAGE);
		const day = await get(`/api/v1/days/${E}`);
		expect(day.status).toBe(200);
		expect(await day.json()).toMatchObject({
			status: 'settled',
			print: { revision: 1 },
			misfiled: { objects: [`prints/et/${E}/r2.json`] },
		});
		expect(await correctionsView(store)).toEqual([]);
	});
});

describe('a receipt counts only at its own key, in its own partition (finding 3)', () => {
	it('never settles a receipt stored only under another UTC partition', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		await collectAt('2027-01-02T04:55:03Z');
		await rename(
			path.join(root, 'rounds/2027-01-02/2027-01-02T04:55Z.json'),
			path.join(root, 'rounds/2027-01-01/2027-01-02T04:55Z.json'),
		);
		expect((await get('/api/v1/rounds/2027-01-02T04:55Z')).status).toBe(404);
		const response = await settle(E, '2027-01-02T05:30:00Z');
		expect(response.status).toBe(200);
		const day = await get(`/api/v1/days/${E}`);
		expect(await day.json()).toMatchObject({
			print: { rounds: [expect.objectContaining({ roundId: '2027-01-01T05:00Z' })] },
		});
	});

	it('refuses a receipt stored at another round’s key', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		await rename(
			path.join(root, 'rounds/2027-01-01/2027-01-01T05:00Z.json'),
			path.join(root, 'rounds/2027-01-01/2027-01-01T06:00Z.json'),
		);
		const response = await settle(E, '2027-01-02T05:30:00Z');
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			status: 'failed',
			reason: 'rounds/2027-01-01/2027-01-01T06:00Z.json holds round 2027-01-01T05:00Z',
		});
	});

	it('keeps /current up when a round summary is copied into another partition’s index', async () => {
		await collectAt('2027-01-02T04:50:03Z');
		const index = await store.read('days/2027-01-02.json');
		if (index === null) throw new Error('collect writes the day index');
		await put('days/2027-01-01.json', index.body);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2027-01-02T04:52:00Z'));
		const current = await get('/api/v1/current');
		expect(current.status).toBe(200);
		expect(await current.json()).toMatchObject({ date: E, coverage: { validRounds: 1 } });
	});
});

describe('history reads only the roots that own the requested dates (finding 4)', () => {
	it('serves a v1-only range past a malformed ET history, and reports it on an ET range', async () => {
		await collectAt('2026-12-31T10:00:03Z');
		expect((await settle(V1_DAY, '2027-01-01T00:30:00Z')).status).toBe(200);
		await put('prints/et/history.json', GARBAGE);
		const v1Only = await get(`/api/v1/history?from=2026-12-01&to=${V1_DAY}`);
		expect(v1Only.status).toBe(200);
		expect(await v1Only.json()).toMatchObject({
			days: [expect.objectContaining({ date: V1_DAY })],
		});
		const both = await get(`/api/v1/history?from=2026-12-01&to=${E}`);
		expect(both.status).toBe(200);
		expect(await both.json()).toMatchObject({
			days: [expect.objectContaining({ date: V1_DAY })],
			misfiled: { problem: 'misfiled_print', objects: ['prints/et/history.json'] },
		});
	});

	it('rebuilds a malformed history from its root’s prints on the next settle', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		expect((await settle(E, '2027-01-02T05:30:00Z')).status).toBe(200);
		await writeFile(path.join(root, 'prints/et/history.json'), GARBAGE);
		const broken = await get(`/api/v1/history?from=${E}&to=2027-01-02`);
		expect(await broken.json()).toMatchObject({
			days: [],
			misfiled: { objects: ['prints/et/history.json'] },
		});
		expect((await settle('2027-01-02', '2027-01-03T05:30:00Z')).status).toBe(200);
		const rebuilt = await (await get(`/api/v1/history?from=${E}&to=2027-01-02`)).json();
		expect(rebuilt).not.toHaveProperty('misfiled');
		expect(rebuilt.days.map((day: { date: string }) => day.date)).toEqual([E, '2027-01-02']);
	});
});

describe('a day index that does not decode is rebuilt, never thrown on (#34, item 1)', () => {
	it('keeps /current up during an ET day when the previous partition’s index is malformed', async () => {
		await collectAt('2027-01-01T05:00:03Z');
		await collectAt('2027-01-02T02:55:03Z');
		await writeFile(path.join(root, 'days/2027-01-01.json'), GARBAGE);
		await collectAt('2027-01-02T03:00:03Z');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2027-01-02T03:01:00Z'));
		const current = await get('/api/v1/current');
		expect(current.status).toBe(200);
		expect(await current.json()).toMatchObject({ date: E, coverage: { validRounds: 3 } });
		// Rebuilt in place from the partition's receipts.
		const index = await store.read('days/2027-01-01.json');
		expect(JSON.parse(new TextDecoder().decode(index?.body))).toMatchObject({
			date: '2027-01-01',
			rounds: [expect.objectContaining({ roundId: '2027-01-01T05:00Z' })],
		});
	});
});
