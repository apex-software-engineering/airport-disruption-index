/**
 * Before v2's notice ships (`noticePublishedAt: null`), the indicative series is not public: its
 * API answers 404, no page reads it, and the settle run freezes nothing. v1 settlement is
 * untouched. The registry is mocked, mirroring the published suite, so this suite keeps holding
 * after step 1 sets `noticePublishedAt` in the real one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as settleRoute } from '@/app/api/cron/settle/route';
import { readSiteData } from '@/components/index-data';
import { config, proxy } from '@/proxy';
import { indicativeSeriesPublished, indicativeSeriesPublishedIn } from '@/lib/index/indicative';
import { METHODOLOGY_V1, METHODOLOGY_V2, release } from '@/lib/index/releases';
import { collectAt } from '@/test/collect';

import { readIndicativePrints } from './archive';
import { FileStore } from './storage';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17'),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', { noticePublishedAt: null }),
		],
	};
});

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-unpublished-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
	vi.stubEnv('CRON_SECRET', 'test-cron-secret');
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const NOT_PUBLISHED = { error: 'the indicative series is not yet published' };

describe('the indicative series before its notice', () => {
	it('is published only once its release records noticePublishedAt', () => {
		expect(indicativeSeriesPublished()).toBe(false);
		const step1 = [
			release(METHODOLOGY_V1, '2026-11-17'),
			release(METHODOLOGY_V2, '2027-01-01', { noticePublishedAt: '2026-11-25T15:00:00.000Z' }),
		];
		expect(indicativeSeriesPublishedIn(step1)).toBe(true);
		// A notice on a release without an indicative series publishes nothing.
		expect(
			indicativeSeriesPublishedIn([
				release(METHODOLOGY_V1, '2026-11-17', { noticePublishedAt: '2026-11-25T15:00:00.000Z' }),
				release(METHODOLOGY_V2, '2027-01-01'),
			]),
		).toBe(false);
	});

	it('answers 404 under /api/v1/indicative before any route, whatever the method', async () => {
		// The proxy runs for every method (GET, HEAD, OPTIONS, …) on the whole prefix.
		expect(config.matcher).toEqual(['/api/v1/indicative', '/api/v1/indicative/:path*']);
		const response = proxy();
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual(NOT_PUBLISHED);
	});

	it('is read by no page', async () => {
		const data = await readSiteData(new Date('2026-11-23T12:00:00Z'));
		expect(data.indicative).toBeNull();
		expect(data.recentIndicative).toBeNull();
	});

	it('is not frozen by the settle run, which still settles the v1 day', async () => {
		for (const at of ['2026-11-21T05:00:03Z', '2026-11-21T12:00:03Z', '2026-11-22T04:55:03Z']) {
			await collectAt(store, at);
		}
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-23T00:30:00Z'));
		const response = await settleRoute(
			new Request('http://test/api/cron/settle', {
				headers: { authorization: 'Bearer test-cron-secret' },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 'settled',
			date: '2026-11-22',
			indicative: [],
		});
		expect(await readIndicativePrints(store, '2026-11-20', '2026-11-30')).toEqual([]);
	});
});
