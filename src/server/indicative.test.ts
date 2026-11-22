/**
 * The indicative ET series end to end over a filesystem store: rounds collected under v1 (as in
 * production today), an ET day frozen from both UTC partitions after its cutoff, served by the API
 * with its zone and standing, and reproduced from the public API, once the series is published.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as settleRoute } from '@/app/api/cron/settle/route';
import { GET as indicativeDayRoute } from '@/app/api/v1/indicative/days/[date]/route';
import { GET as indicativeHistoryRoute } from '@/app/api/v1/indicative/history/route';
import { INDICATIVE_SERIES } from '@/lib/index/indicative';
import { reproduceIndicative } from '@/lib/reproduce';
import { proxy } from '@/proxy';
import { routeGet } from '@/test/api';
import { collectAt } from '@/test/collect';

import { hashJson } from '@/lib/index/json';
import { receiptSchema } from '@/lib/index/schemas';
import type { Get } from '@/lib/reproduce';

import {
	freezeIndicativeDay,
	readIndicativePrint,
	readIndicativePrints,
	readReceipt,
} from './archive';
import { FileStore } from './storage';
import { indicativeDayView } from './views';

// The series is published: v2's notice has shipped (the unpublished state has its own suite).
vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17'),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', {
				noticePublishedAt: '2026-11-25T15:00:00.000Z',
			}),
		],
	};
});

const DAY = '2026-11-20';
const AFTER_FREEZE = new Date('2026-11-21T05:30:00Z');

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-indicative-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
	vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** Rounds around ET day 2026-11-20 ([05:00Z, next 05:00Z)): two outside it, three inside. */
async function collectAround() {
	for (const at of [
		'2026-11-20T04:55:03Z', // 23:55 EST on the 19th: outside
		'2026-11-20T05:00:03Z', // the day's first slot
		'2026-11-20T23:55:03Z', // the last slot in the first UTC partition
		'2026-11-21T04:55:03Z', // the day's last slot, in the second UTC partition
		'2026-11-21T05:00:03Z', // the next day: outside
	]) {
		await collectAt(store, at);
	}
}

describe('freezing an indicative ET day', () => {
	it('refuses before the day’s end plus the cutoff, so admission has closed', async () => {
		await expect(freezeIndicativeDay(store, DAY, new Date('2026-11-21T05:29:59Z'))).rejects.toThrow(
			'2026-11-20 (ET, indicative) freezes at 2026-11-21T05:30:00.000Z',
		);
	});

	it('builds the day from both UTC partitions, inside its window only, under v2', async () => {
		await collectAround();
		const { status, print } = await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		expect(status).toBe('frozen');
		expect(print.rounds.map((r) => r.roundId)).toEqual([
			'2026-11-20T05:00Z',
			'2026-11-20T23:55Z',
			'2026-11-21T04:55Z',
		]);
		expect(print).toMatchObject({
			standing: 'indicative',
			methodologyVersion: '2.0.0',
			coverage: { slotsPerDay: 288, validRounds: 3 },
			result: { status: 'suspended', reason: 'coverage 3/288 valid rounds is below 80%' },
		});
	});

	it('writes once and never revises', async () => {
		await collectAround();
		const first = await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		await collectAt(store, '2026-11-20T12:00:03Z'); // a write after freezing changes nothing
		const second = await freezeIndicativeDay(store, DAY, new Date('2026-11-25T00:00:00Z'));
		expect(second).toEqual({ status: 'already_frozen', print: first.print });
		expect(await readIndicativePrints(store, DAY, DAY)).toEqual([first.print]);
	});

	it('never reads a receipt outside the window, and stops on an unreadable one inside it', async () => {
		await collectAround();
		const outside = 'rounds/2026-11-20/2026-11-20T04:50Z.json';
		await store.write(outside, new TextEncoder().encode('not json'), 'application/json', {
			kind: 'if-absent',
		});
		expect((await freezeIndicativeDay(store, DAY, AFTER_FREEZE)).status).toBe('frozen');
		// In ET day 2026-11-21's window ([2026-11-21T05:00Z, 2026-11-22T05:00Z)).
		const inside = 'rounds/2026-11-21/2026-11-21T06:00Z.json';
		await store.write(inside, new TextEncoder().encode('not json'), 'application/json', {
			kind: 'if-absent',
		});
		await expect(
			freezeIndicativeDay(store, '2026-11-21', new Date('2026-11-22T05:30:00Z')),
		).rejects.toThrow();
	});

	it('keeps a receipt under an identity it does not admit, even an unknown one, and suspends', async () => {
		await collectAround();
		const stored = await readReceipt(store, '2026-11-20T05:00Z');
		if (stored === null) throw new Error('the round was collected');
		// A receipt from a release this code does not know: listed and counted as foreign, not thrown.
		const { receiptHash, ...unsigned } = {
			...stored,
			roundId: '2026-11-20T06:00Z',
			slotStart: '2026-11-20T06:00:00.000Z',
			fetchedAt: '2026-11-20T06:00:03.000Z',
			methodologyVersion: '9.9.9',
			parameterHash: 'ef'.repeat(32),
		};
		const unknown = { ...unsigned, receiptHash: hashJson(unsigned) };
		expect(receiptSchema.safeParse(unknown).success).toBe(false);
		await store.write(
			'rounds/2026-11-20/2026-11-20T06:00Z.json',
			new TextEncoder().encode(JSON.stringify(unknown)),
			'application/json',
			{ kind: 'if-absent' },
		);
		const { print } = await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		expect(print.rounds.map((r) => r.roundId)).toContain('2026-11-20T06:00Z');
		expect(print.result).toMatchObject({
			status: 'suspended',
			reason: expect.stringMatching(
				/^mixed methodology: 1 under 9\.9\.9 \(e{0}(ef){32}\), not 1\.0\.0/,
			),
		});
		// The default round endpoint never serves it; only the frozen print's evidence endpoint does.
		expect((await routeGet('http://test/api/v1/rounds/2026-11-20T06:00Z')).status).toBe(422);
		const evidence = await routeGet(
			'http://test/api/v1/indicative/days/2026-11-20/rounds/2026-11-20T06:00Z',
		);
		expect(evidence.status).toBe(200);
		expect(await evidence.json()).toEqual(unknown);
		const unlisted = 'http://test/api/v1/indicative/days/2026-11-20/rounds/2026-11-20T07:00Z';
		expect((await routeGet(unlisted)).status).toBe(404);
		expect(await reproduceIndicative(DAY, 'http://test', routeGet)).toMatchObject({
			kind: 'match',
		});
	});

	it('counts an admitted receipt only after it rebuilds: a valid one with no response stops the run', async () => {
		await collectAround();
		const stored = await readReceipt(store, '2026-11-20T23:55Z');
		if (stored === null) throw new Error('the round was collected');
		// Valid, but with no HTTP response or body behind it, and a hash that matches the lie.
		const { receiptHash, ...unsigned } = {
			...stored,
			httpStatus: null,
			rawSha256: null,
			rawBytes: null,
		};
		const forged = { ...unsigned, receiptHash: hashJson(unsigned) };
		await store.write(
			'rounds/2026-11-20/2026-11-20T23:55Z.json',
			new TextEncoder().encode(JSON.stringify(forged)),
			'application/json',
			{
				kind: 'if-version',
				version: (await store.read('rounds/2026-11-20/2026-11-20T23:55Z.json'))?.version ?? '',
			},
		);
		await expect(freezeIndicativeDay(store, DAY, AFTER_FREEZE)).rejects.toThrow(
			/2026-11-20T23:55Z\.json does not rebuild: .*valid without an HTTP response/,
		);
	});

	it('never serves an object stored at a day’s key that is the print of another day', async () => {
		await collectAround();
		const { print } = await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		await store.write(
			'indicative/2.0.0/2026-11-21.json',
			new TextEncoder().encode(JSON.stringify(print)),
			'application/json',
			{ kind: 'if-absent' },
		);
		await expect(readIndicativePrint(store, '2026-11-21')).rejects.toThrow(
			'indicative/2.0.0/2026-11-21.json holds the indicative print of 2026-11-20 under 2.0.0',
		);
	});

	it('has no indicative day before the series or from v2’s first day', async () => {
		await expect(freezeIndicativeDay(store, '2026-11-19', AFTER_FREEZE)).rejects.toThrow(
			'2026-11-19 has no indicative day',
		);
		await expect(
			freezeIndicativeDay(store, '2027-01-01', new Date('2027-02-01T00:00:00Z')),
		).rejects.toThrow('2027-01-01 has no indicative day');
	});
});

describe('the indicative API', () => {
	it('lets every request through the proxy once published', () => {
		expect(proxy().headers.get('x-middleware-next')).toBe('1');
	});

	const getDay = (date: string) =>
		indicativeDayRoute(new Request(`http://test/api/v1/indicative/days/${date}`), {
			params: Promise.resolve({ date }),
		});

	it('serves a frozen day with its zone and standing beside the print, cached forever', async () => {
		await collectAround();
		const { print } = await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		const response = await getDay(DAY);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('immutable');
		expect(await response.json()).toEqual({
			series: INDICATIVE_SERIES,
			standing: 'indicative',
			day: 'America/New_York',
			date: DAY,
			print,
		});
	});

	it('says when a day not frozen yet will freeze, and refuses a bad date', async () => {
		const pending = await getDay(DAY);
		expect(pending.status).toBe(404);
		expect(await pending.json()).toMatchObject({
			standing: 'indicative',
			status: 'pending',
			window: { start: '2026-11-20T05:00:00.000Z', end: '2026-11-21T05:00:00.000Z' },
			freezesAt: '2026-11-21T05:30:00.000Z',
		});
		expect((await getDay('2026-02-30')).status).toBe(400);
	});

	it('points a date from v2’s first day at its settlement print', async () => {
		const response = await getDay('2027-01-01');
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ see: '/api/v1/days/2027-01-01' });
		expect(await indicativeDayView(store, '2026-11-19')).toEqual({
			status: 'none',
			date: '2026-11-19',
			reason: 'before_series',
		});
	});

	it('lists frozen days with their zone, window and standing on every entry', async () => {
		await collectAround();
		await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		const response = await indicativeHistoryRoute(
			new Request('http://test/api/v1/indicative/history?from=2026-11-20&to=2026-11-30'),
		);
		const body = await response.json();
		expect(body).toMatchObject({ series: INDICATIVE_SERIES, standing: 'indicative' });
		expect(body.days).toEqual([
			expect.objectContaining({
				date: DAY,
				standing: 'indicative',
				day: 'America/New_York',
				series: INDICATIVE_SERIES,
				window: { start: '2026-11-20T05:00:00.000Z', end: '2026-11-21T05:00:00.000Z' },
				status: 'suspended',
				url: '/api/v1/indicative/days/2026-11-20',
			}),
		]);
	});
});

describe('the settle run and reproduction', () => {
	it('freezes due indicative days after settling, and reports each one', async () => {
		await collectAround();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-22T00:30:00Z'));
		const response = await settleRoute(
			new Request('http://test/api/cron/settle', {
				headers: { authorization: 'Bearer test-cron-secret' },
			}),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).indicative).toEqual([
			expect.objectContaining({ date: DAY, status: 'frozen', result: 'suspended' }),
		]);
	});

	it('refuses a served print for another day before fetching any round it lists', async () => {
		await collectAround();
		await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		const fetched: string[] = [];
		// The API answers the 2026-11-21 request with the 2026-11-20 print under a 2026-11-21 envelope.
		const swapped: Get = async (url) => {
			fetched.push(new URL(url).pathname);
			if (url.endsWith('/indicative/days/2026-11-21')) {
				const body = await (await routeGet(url.replace('2026-11-21', DAY))).json();
				return Response.json({ ...body, date: '2026-11-21' });
			}
			return routeGet(url);
		};
		expect(await reproduceIndicative('2026-11-21', 'http://test', swapped)).toMatchObject({
			kind: 'mismatch',
			problems: ['asked for indicative day 2026-11-21, got the print of 2026-11-20'],
		});
		expect(fetched).toEqual(['/api/v1/indicative/days/2026-11-21']);
	});

	it('reproduces a frozen day from the public API, and cannot verify a pending one', async () => {
		await collectAround();
		await freezeIndicativeDay(store, DAY, AFTER_FREEZE);
		expect(await reproduceIndicative(DAY, 'http://test', routeGet)).toMatchObject({
			kind: 'match',
		});
		expect(await reproduceIndicative('2026-11-21', 'http://test', routeGet)).toMatchObject({
			kind: 'cannot_verify',
		});
	});
});
