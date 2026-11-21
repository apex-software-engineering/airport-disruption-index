import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reproduce } from '@/lib/reproduce';
import type { DailyPrint } from '@/lib/index/schemas';
import { routeGet } from '@/test/api';
import { feedFixture } from '@/test/fixtures';
import { DAY } from '@/test/rounds';

import { correctDay, readHistory, readPrints, settleDay, type CorrectionRequest } from './archive';
import { collectRound } from './collector';
import { FileStore } from './storage';
import { correctionsView, dayView } from './views';

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-correct-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** Inside DAY's corrections window, which closes at DAY+2 00:30Z. */
const IN_WINDOW = new Date('2026-11-18T06:00:00Z');
const AFTER_WINDOW = new Date('2026-11-19T00:30:00Z');

/** DAY with one collected round, settled as revision 1. */
async function settled(): Promise<DailyPrint> {
	const fetchedAt = new Date('2026-11-17T20:45:03Z');
	await collectRound(
		store,
		async () => ({
			fetchedAt,
			outcome: { kind: 'response', httpStatus: 200, body: feedFixture('synthetic-gs-gdp.xml') },
		}),
		() => new Date(fetchedAt.getTime() + 1000),
	);
	return (await settleDay(store, DAY)).print;
}

function request(supersedes: DailyPrint, windowOverride: string | null = null): CorrectionRequest {
	return {
		supersedesPrintHash: supersedes.printHash,
		reason: 'misconfigured deployment',
		windowOverride,
	};
}

/** Every stored object under prints/, byte for byte. */
async function storedPrints(): Promise<Map<string, string>> {
	const keys = await store.list('prints/');
	const objects = await Promise.all(
		keys.map(async (key) => [key, (await store.read(key))?.version]),
	);
	return new Map(objects.filter((entry): entry is [string, string] => entry[1] !== undefined));
}

describe('correctDay', () => {
	it('writes the next revision from the receipts, leaves r1 untouched and cites it in history', async () => {
		const original = await settled();
		const r1Bytes = (await store.read(`prints/${DAY}/r1.json`))?.version;
		const corrected = await correctDay(store, DAY, request(original), IN_WINDOW);

		expect(corrected).toMatchObject({
			revision: 2,
			correction: {
				supersedesPrintHash: original.printHash,
				reason: 'misconfigured deployment',
				issuedAt: IN_WINDOW.toISOString(),
				windowOverride: null,
			},
			result: original.result,
			rounds: original.rounds,
		});
		expect((await store.read(`prints/${DAY}/r1.json`))?.version).toBe(r1Bytes);
		expect(await readPrints(store, DAY)).toEqual([original, corrected]);
		expect((await readHistory(store)).days).toMatchObject([
			{ date: DAY, revision: 2, printHash: corrected.printHash },
		]);
		expect(await dayView(store, DAY)).toMatchObject({ print: { revision: 2 } });
	});

	it('produces a revision that reproduces from the public API: MATCH', async () => {
		await correctDay(store, DAY, request(await settled()), IN_WINDOW);
		const outcome = await reproduce(DAY, 'http://adi.test', routeGet);
		expect(outcome).toMatchObject({ kind: 'match' });
		expect(outcome.log).toEqual([expect.stringMatching(/^print 2026-11-17 r2: /)]);
	});

	it('chains: a further correction supersedes the latest revision', async () => {
		const r2 = await correctDay(store, DAY, request(await settled()), IN_WINDOW);
		const r3 = await correctDay(store, DAY, request(r2), IN_WINDOW);
		expect(r3).toMatchObject({ revision: 3, correction: { supersedesPrintHash: r2.printHash } });
	});

	it('refuses a hash that is not the latest revision, and writes nothing', async () => {
		const original = await settled();
		await correctDay(store, DAY, request(original), IN_WINDOW);
		const before = await storedPrints();
		await expect(correctDay(store, DAY, request(original), IN_WINDOW)).rejects.toThrow(
			/is r1, but the latest revision of 2026-11-17 is r2/,
		);
		await expect(
			correctDay(
				store,
				DAY,
				{ ...request(original), supersedesPrintHash: 'f'.repeat(64) },
				IN_WINDOW,
			),
		).rejects.toThrow(/is not a print of 2026-11-17/);
		expect(await storedPrints()).toEqual(before);
	});

	it('refuses a day that has not settled', async () => {
		await expect(
			correctDay(
				store,
				DAY,
				{ supersedesPrintHash: 'f'.repeat(64), reason: 'x', windowOverride: null },
				IN_WINDOW,
			),
		).rejects.toThrow(/has not settled/);
	});

	it('refuses after the window unless the override states why, and records the justification', async () => {
		const original = await settled();
		await expect(correctDay(store, DAY, request(original), AFTER_WINDOW)).rejects.toThrow(
			/corrections window closed at 2026-11-19T00:30:00.000Z/,
		);
		await expect(
			correctDay(store, DAY, request(original, 'needed for once'), IN_WINDOW),
		).rejects.toThrow(/records none/);
		expect(await readPrints(store, DAY)).toEqual([original]);

		const late = await correctDay(
			store,
			DAY,
			request(original, 'FAA confirmed the feed served stale data on D+1'),
			AFTER_WINDOW,
		);
		expect(late.correction).toMatchObject({
			issuedAt: AFTER_WINDOW.toISOString(),
			windowOverride: 'FAA confirmed the feed served stale data on D+1',
		});
	});
});

describe('correctionsView', () => {
	it('lists every correction print, newest first, and nothing for an uncorrected day', async () => {
		const original = await settled();
		expect(await correctionsView(store)).toEqual([]);
		const r2 = await correctDay(store, DAY, request(original), IN_WINDOW);
		const r3 = await correctDay(store, DAY, request(r2), new Date('2026-11-18T07:00:00Z'));
		expect(await correctionsView(store)).toEqual([
			{
				date: DAY,
				revision: 3,
				printHash: r3.printHash,
				...r3.correction,
				url: `/api/v1/days/${DAY}`,
			},
			{
				date: DAY,
				revision: 2,
				printHash: r2.printHash,
				...r2.correction,
				url: `/api/v1/days/${DAY}`,
			},
		]);
	});
});
