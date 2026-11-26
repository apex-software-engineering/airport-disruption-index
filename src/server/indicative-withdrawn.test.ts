/**
 * A withdrawn v2 ends the indicative series: no further day is frozen, a day never frozen answers
 * that it has none, and a print frozen before the withdrawal is still served. The registry is the
 * only thing mocked.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as indicativeDayRoute } from '@/app/api/v1/indicative/days/[date]/route';
import { dayWindow } from '@/lib/index/calendar';
import { indicativeAdmissionFor } from '@/lib/index/indicative';
import { buildIndicativePrint } from '@/lib/index/print';
import { RELEASES } from '@/lib/index/releases';

import { freezeIndicativeDay } from './indicative-archive';
import { FileStore } from './storage';
import { indicativeDayView } from './views';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17'),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', {
				withdrawn: true,
				noticePublishedAt: '2026-11-25T15:00:00.000Z',
			}),
		],
	};
});

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-withdrawn-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

describe('a withdrawn release', () => {
	it('freezes nothing more, and a day never frozen has no indicative day (404, not pending)', async () => {
		await expect(
			freezeIndicativeDay(store, '2026-11-21', new Date('2026-11-23T00:00:00Z')),
		).rejects.toThrow('2026-11-21 has no indicative day');
		expect(await indicativeDayView(store, '2026-11-21')).toEqual({
			status: 'none',
			date: '2026-11-21',
			reason: 'withdrawn',
		});
		const response = await indicativeDayRoute(
			new Request('http://test/api/v1/indicative/days/2026-11-21'),
			{ params: Promise.resolve({ date: '2026-11-21' }) },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: '2026-11-21 was not frozen before its release was withdrawn',
		});
	});

	it('still serves a print frozen before the withdrawal', async () => {
		const v2 = RELEASES[1];
		const admission = v2 === undefined ? null : indicativeAdmissionFor(v2);
		if (v2 === undefined || admission === null) throw new Error('the mocked registry lists v2');
		const print = buildIndicativePrint(
			{ release: v2, window: dayWindow(v2, '2026-11-20') },
			[],
			admission,
		);
		await store.write(
			'indicative/2.0.0/2026-11-20.json',
			new TextEncoder().encode(JSON.stringify(print)),
			'application/json',
			{ kind: 'if-absent' },
		);
		expect(await indicativeDayView(store, '2026-11-20')).toMatchObject({
			status: 'frozen',
			body: { print },
		});
	});
});
