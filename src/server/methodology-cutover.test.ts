/**
 * A methodology release taking effect at a UTC day boundary, with a test-only v2 that swaps a
 * panel airport. The registry is the only thing mocked: every other module reads it as in
 * production.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settlementDay } from '@/lib/index/calendar';

import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { settlementReleaseFor } from '@/lib/index/methodology';
import { buildPrint } from '@/lib/index/print';
import { buildReceipt, type FetchOutcome } from '@/lib/index/round';
import { METHODOLOGY_V1 } from '@/lib/index/releases';
import { reproduce } from '@/lib/reproduce';
import { routeGet } from '@/test/api';
import { feedFixtureText } from '@/test/fixtures';
import { validRange } from '@/test/rounds';

import { readDayReceipts, recordRound, settleDay } from './archive';
import { collectRound } from './collector';
import { FileStore } from './storage';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	const v2 = {
		...actual.METHODOLOGY_V1,
		version: '2.0.0',
		panel: [...actual.METHODOLOGY_V1.panel.filter((code) => code !== 'DTW'), 'SAN'],
	};
	// A cutover between two UTC-day releases, activated: v1 ends the day before v2 starts.
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17', { effectiveUntil: '2026-11-17' }),
			actual.release(v2, '2026-11-18', {
				announcedAt: '2026-10-01T00:00:00.000Z',
				announcedProofAt: '2026-10-01T01:00:00.000Z',
			}),
		],
	};
});

const V1_DAY = '2026-11-17';
const V2_DAY = '2026-11-18';

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-cutover-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** The GS/GDP fixture (SFO GDP, LGA GS+GDP) with its Update_Time moved to `at`. */
function feedAt(at: Date): FetchOutcome {
	const stamp = at
		.toUTCString()
		.replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/, '$1 $3 $2 $5 $4 GMT');
	const xml = feedFixtureText('synthetic-gs-gdp.xml').replace(
		'Tue Nov 17 20:43:54 2026 GMT',
		stamp,
	);
	return { kind: 'response', httpStatus: 200, body: new TextEncoder().encode(xml) };
}

/** Collects one round fetched at `at`, as the deployed collector would. */
function collectAt(at: string) {
	const fetchedAt = new Date(at);
	return collectRound(
		store,
		async () => ({ fetchedAt, outcome: feedAt(new Date(fetchedAt.getTime() - 60_000)) }),
		() => new Date(fetchedAt.getTime() + 1000),
	);
}

describe('a release that takes effect at a UTC day boundary', () => {
	it('computes each side of the cutover under its own methodology and panel', () => {
		const before = buildPrint(
			settlementDay(V1_DAY),
			validRange(0, 288, [{ airport: 'DTW', gs: true }], V1_DAY),
			{ revision: 1 },
		);
		const after = buildPrint(
			settlementDay(V2_DAY),
			validRange(0, 288, [{ airport: 'SAN', gs: true }], V2_DAY),
			{ revision: 1 },
		);
		expect(before).toMatchObject({
			methodologyVersion: '1.0.0',
			result: { status: 'final', value: 1440 },
		});
		expect(after).toMatchObject({
			methodologyVersion: '2.0.0',
			result: { status: 'final', value: 1440 },
		});
		const panelOf = (print: typeof before) =>
			print.result.status === 'suspended' ? [] : print.result.airports.map((a) => a.airport);
		expect(panelOf(before)).toEqual([...METHODOLOGY_V1.panel]);
		expect(panelOf(after)).toContain('SAN');
		expect(panelOf(after)).not.toContain('DTW');
		expect(before.parameterHash).toBe(settlementReleaseFor(V1_DAY).parameterHash);
		expect(after.parameterHash).toBe(settlementReleaseFor(V2_DAY).parameterHash);
		expect(after.parameterHash).not.toBe(before.parameterHash);
	});

	it('collects and settles the days either side of the cutover, each under its own release', async () => {
		await collectAt(`${V1_DAY}T23:55:03Z`);
		await collectAt(`${V2_DAY}T00:00:03Z`);
		const [before] = await readDayReceipts(store, V1_DAY);
		const [after] = await readDayReceipts(store, V2_DAY);
		expect(before?.methodologyVersion).toBe('1.0.0');
		expect(after?.methodologyVersion).toBe('2.0.0');
		expect(after?.observation).toMatchObject({ status: 'valid' });
		for (const date of [V1_DAY, V2_DAY]) {
			const { print } = await settleDay(store, date);
			expect(print.methodologyVersion).toBe(settlementReleaseFor(date).parameters.version);
			expect(print.result).toEqual({
				status: 'suspended',
				reason: 'coverage 1/288 valid rounds is below 80%',
			});
		}
	});
});

describe('a day with rounds from two panel versions', () => {
	/** A v1 collector still running after v2 took effect, then the v2 one. */
	async function mixedDay() {
		const late = new Date(`${V2_DAY}T00:05:03Z`);
		const outcome = feedAt(new Date(late.getTime() - 60_000));
		if (outcome.kind !== 'response') throw new Error('the fixture outcome has a body');
		const stale = buildReceipt({
			fetchedAt: late,
			sourceUrl: CURRENT_ADAPTER.url,
			outcome,
			methodology: settlementReleaseFor(V1_DAY),
			adapterVersion: CURRENT_ADAPTER.version,
		});
		await recordRound(store, stale, outcome.body, new Date(late.getTime() + 1000));
		await collectAt(`${V2_DAY}T00:10:03Z`);
		return settleDay(store, V2_DAY);
	}

	it('validates each archived receipt under the panel it records, and suspends the day', async () => {
		const { print } = await mixedDay();
		const receipts = await readDayReceipts(store, V2_DAY);
		expect(receipts.map((r) => [r.methodologyVersion, r.observation.status])).toEqual([
			['1.0.0', 'valid'],
			['2.0.0', 'valid'],
		]);
		const v1 = receipts[0]?.observation;
		expect(v1?.status === 'valid' && v1.panel.map((row) => row.airport)).toEqual([
			...METHODOLOGY_V1.panel,
		]);
		expect(print.result.status).toBe('suspended');
		expect(print.result).toMatchObject({
			reason: expect.stringMatching(
				/^mixed methodology: 1 under 1\.0\.0 \([0-9a-f]{64}\), not 2\.0\.0/,
			),
		});
		expect(print.rounds).toHaveLength(2);
	});

	it('reproduces the suspended print from the public API: MATCH', async () => {
		await mixedDay();
		const outcome = await reproduce(V2_DAY, 'http://adi.test', routeGet);
		expect(outcome).toMatchObject({ kind: 'match' });
		expect(outcome.log).toEqual([
			expect.stringMatching(/^print 2026-11-18 r1: suspended, 2 rounds/),
		]);
	});
});
