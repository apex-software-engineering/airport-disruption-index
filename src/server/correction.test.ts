import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reproduce } from '@/lib/reproduce';
import type { DailyPrint } from '@/lib/index/schemas';
import { routeGet } from '@/test/api';
import { feedFixture } from '@/test/fixtures';
import { buildPrint } from '@/lib/index/print';
import { correctionOf, DAY } from '@/test/rounds';

import { correctDay, readHistory, readPrints, settleDay, type CorrectionRequest } from './archive';
import { collectRound } from './collector';
import { FileStore } from './storage';
import { correctionsView, dayView } from './views';

/** Runs inside every `printBody` call, the aggregation step of a print. */
const aggregation = vi.hoisted(() => ({ during: (): void => undefined }));
vi.mock('@/lib/index/print', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/print')>();
	return {
		...actual,
		printBody: (...args: Parameters<typeof actual.printBody>) => {
			aggregation.during();
			return actual.printBody(...args);
		},
	};
});

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-correct-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	aggregation.during = () => undefined;
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
		const corrected = await correctDay(store, DAY, request(original), () => IN_WINDOW);

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
		await correctDay(store, DAY, request(await settled()), () => IN_WINDOW);
		const outcome = await reproduce(DAY, 'http://adi.test', routeGet);
		expect(outcome).toMatchObject({ kind: 'match' });
		expect(outcome.log).toEqual([expect.stringMatching(/^print 2026-11-17 r2: /)]);
	});

	it('chains: a further correction supersedes the latest revision', async () => {
		const r2 = await correctDay(store, DAY, request(await settled()), () => IN_WINDOW);
		const r3 = await correctDay(store, DAY, request(r2), () => IN_WINDOW);
		expect(r3).toMatchObject({ revision: 3, correction: { supersedesPrintHash: r2.printHash } });
	});

	it('refuses a hash that is not the latest revision, and writes nothing', async () => {
		const original = await settled();
		await correctDay(store, DAY, request(original), () => IN_WINDOW);
		const before = await storedPrints();
		await expect(correctDay(store, DAY, request(original), () => IN_WINDOW)).rejects.toThrow(
			/is r1, but the latest revision of 2026-11-17 is r2/,
		);
		await expect(
			correctDay(
				store,
				DAY,
				{ ...request(original), supersedesPrintHash: 'f'.repeat(64) },
				() => IN_WINDOW,
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
				() => IN_WINDOW,
			),
		).rejects.toThrow(/has not settled/);
	});

	it('refuses after the window unless the override states why, and records the justification', async () => {
		const original = await settled();
		await expect(correctDay(store, DAY, request(original), () => AFTER_WINDOW)).rejects.toThrow(
			/corrections window closed at 2026-11-19T00:30:00.000Z/,
		);
		await expect(
			correctDay(store, DAY, request(original, 'needed for once'), () => IN_WINDOW),
		).rejects.toThrow(/records none/);
		expect(await readPrints(store, DAY)).toEqual([original]);

		const late = await correctDay(
			store,
			DAY,
			request(original, 'FAA confirmed the feed served stale data on D+1'),
			() => AFTER_WINDOW,
		);
		expect(late.correction).toMatchObject({
			issuedAt: AFTER_WINDOW.toISOString(),
			windowOverride: 'FAA confirmed the feed served stale data on D+1',
		});
	});

	it('judges the window when the print is written, not when the command started', async () => {
		const original = await settled();
		let now = new Date('2026-11-19T00:29:59Z');
		// Reading the day's receipts takes the clock past the window's close, D+2 00:30Z.
		class SlowStore extends FileStore {
			override async list(prefix: string) {
				if (prefix.startsWith('rounds/')) now = new Date('2026-11-19T00:30:01Z');
				return super.list(prefix);
			}
		}
		await expect(
			correctDay(new SlowStore(root), DAY, request(original), () => now),
		).rejects.toThrow(/corrections window closed/);
		expect(await readPrints(store, DAY)).toEqual([original]);
	});

	it('reads the issue time after aggregation, so a window that closes meanwhile refuses', async () => {
		const original = await settled();
		let now = new Date('2026-11-19T00:29:59Z');
		aggregation.during = () => {
			now = new Date('2026-11-19T00:30:01Z');
		};
		await expect(correctDay(store, DAY, request(original), () => now)).rejects.toThrow(
			/corrections window closed/,
		);
		expect(await readPrints(store, DAY)).toEqual([original]);
	});
});

describe('correctionsView', () => {
	it('lists every correction print, newest first, and nothing for an uncorrected day', async () => {
		const original = await settled();
		expect(await correctionsView(store)).toEqual([]);
		const r2 = await correctDay(store, DAY, request(original), () => IN_WINDOW);
		const r3 = await correctDay(store, DAY, request(r2), () => new Date('2026-11-18T07:00:00Z'));
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

	it('reads stored corrections at most READ_CONCURRENCY (16) at a time', async () => {
		let latest = await settled();
		for (let i = 0; i < 20; i += 1)
			latest = await correctDay(store, DAY, request(latest), () => IN_WINDOW);
		let inFlight = 0;
		let peak = 0;
		class CountingStore extends FileStore {
			override async read(key: string) {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					return await super.read(key);
				} finally {
					inFlight -= 1;
				}
			}
		}
		expect(await correctionsView(new CountingStore(root))).toHaveLength(20);
		expect(peak).toBe(16);
	});

	it('lists a correction whose history update was lost', async () => {
		const original = await settled();
		const r2 = buildPrint(DAY, [], { revision: 2, correction: correctionOf(original.printHash) });
		await store.write(
			`prints/${DAY}/r2.json`,
			new TextEncoder().encode(JSON.stringify(r2)),
			'application/json',
			{ kind: 'if-absent' },
		);
		expect((await readHistory(store)).days).toMatchObject([{ revision: 1 }]);
		expect(await correctionsView(store)).toMatchObject([{ revision: 2, printHash: r2.printHash }]);
	});
});
