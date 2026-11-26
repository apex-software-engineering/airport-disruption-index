import { describe, expect, it } from 'vitest';

import { dayWindow, type SettlementDay } from './calendar';
import {
	dueIndicativeDays,
	indicativeAdmissionFor,
	indicativeReleaseFor,
	indicativeReleaseIn,
	INDICATIVE_ADMISSION_POLICY,
} from './indicative';
import { canonicalJson, hashJson } from './json';
import { identityOf } from './methodology';
import { buildIndicativePrint, printHashMatches } from './print';
import { METHODOLOGY_V1, METHODOLOGY_V2, release, RELEASES } from './releases';
import { indicativePrintSchema, type RoundSummary } from './schemas';
import { roundIdFor } from './time';

function registered(index: number) {
	const found = RELEASES[index];
	if (found === undefined) throw new Error(`the registry has no release ${index}`);
	return found;
}
const V1 = registered(0);
const V2 = registered(1);
const ADMISSION = indicativeAdmissionFor(V2);
if (ADMISSION === null) throw new Error('v2 has an indicative admission policy');

describe('which release an indicative day is computed under', () => {
	it('is v2 for every label from the first full ET day to the day before v2 takes effect', () => {
		expect(indicativeReleaseFor('2026-11-19')).toBeNull();
		expect(indicativeReleaseFor('2026-11-20')).toBe(V2);
		expect(indicativeReleaseFor('2026-12-31')).toBe(V2);
		// From v2's first day there is no indicative day: v2 itself owns it.
		expect(indicativeReleaseFor('2027-01-01')).toBeNull();
		expect(indicativeReleaseFor('2030-06-01')).toBeNull();
	});

	it('is chosen by label: the same in step 1, once announced, and after v2 takes effect', () => {
		const step1 = [release(METHODOLOGY_V1, '2026-11-17'), release(METHODOLOGY_V2, '2027-01-01')];
		const activated = [
			release(METHODOLOGY_V1, '2026-11-17', { effectiveUntil: '2026-12-31' }),
			release(METHODOLOGY_V2, '2027-01-01', { announcedAt: '2026-11-25T15:00:00.000Z' }),
		];
		for (const registry of [step1, activated]) {
			for (const label of ['2026-11-20', '2026-12-31']) {
				expect(
					indicativeReleaseIn(registry, label, { includeWithdrawn: false })?.parameters.version,
				).toBe('2.0.0');
			}
			expect(indicativeReleaseIn(registry, '2027-01-01', { includeWithdrawn: false })).toBeNull();
		}
	});

	it('ends with a withdrawal, while published prints stay reproducible', () => {
		const withdrawn = [
			release(METHODOLOGY_V1, '2026-11-17'),
			release(METHODOLOGY_V2, '2027-01-01', { withdrawn: true }),
		];
		expect(indicativeReleaseIn(withdrawn, '2026-12-01', { includeWithdrawn: false })).toBeNull();
		expect(
			indicativeReleaseIn(withdrawn, '2026-12-01', { includeWithdrawn: true })?.parameters.version,
		).toBe('2.0.0');
	});

	it('pins the admitted pairs by value: no registry order or inserted release changes them', () => {
		const pinned = [
			{ methodologyVersion: '1.0.0', parameterHash: hashJson(METHODOLOGY_V1) },
			{ methodologyVersion: '2.0.0', parameterHash: hashJson(METHODOLOGY_V2) },
		];
		expect(ADMISSION.accepts).toEqual(pinned);
		// The same release object wherever it sits in a registry gets the same policy...
		expect(indicativeAdmissionFor(release(METHODOLOGY_V2, '2028-01-01'))).toEqual(ADMISSION);
		// ...a release inserted before v2 gets none, so labels it owns have no indicative day...
		const inserted = { ...METHODOLOGY_V1, version: '1.5.0' };
		const registry = [
			release(METHODOLOGY_V1, '2026-11-17'),
			release(inserted, '2026-12-01'),
			release(METHODOLOGY_V2, '2027-01-01'),
		];
		expect(indicativeReleaseIn(registry, '2026-11-25', { includeWithdrawn: false })).toBeNull();
		expect(
			indicativeReleaseIn(registry, '2026-12-15', { includeWithdrawn: false })?.parameters.version,
		).toBe('2.0.0');
		// ...and a release reusing v2's version with other parameters gets none either.
		const altered = { ...METHODOLOGY_V2, minutesPerActiveSlot: 10 };
		expect(indicativeAdmissionFor(release(altered, '2027-01-01'))).toBeNull();
	});

	it('admits exactly v1 and v2, under a named policy, and nothing for a release without one', () => {
		expect(ADMISSION).toEqual({
			policy: INDICATIVE_ADMISSION_POLICY,
			accepts: [identityOf(V1), identityOf(V2)],
		});
		expect(indicativeAdmissionFor(V1)).toBeNull();
	});

	it('freezes a day only once its end plus the cutoff has passed', () => {
		expect(dueIndicativeDays(new Date('2026-11-21T05:29:59Z'), 3)).toEqual([]);
		expect(dueIndicativeDays(new Date('2026-11-21T05:30:00Z'), 3)).toEqual(['2026-11-20']);
		expect(dueIndicativeDays(new Date('2026-11-22T05:30:00Z'), 3)).toEqual([
			'2026-11-20',
			'2026-11-21',
		]);
	});
});

/** A valid round summary for the slot starting at `slotStart`, recorded under `identity`. */
function roundAt(slotStart: Date, identity = identityOf(V1)): RoundSummary {
	return {
		roundId: roundIdFor(slotStart),
		fetchedAt: new Date(slotStart.getTime() + 3000).toISOString(),
		receiptHash: 'cd'.repeat(32),
		...identity,
		observation: {
			status: 'valid',
			feedUpdateTime: slotStart.toISOString(),
			active: [{ airport: 'JFK', groundStop: true, groundDelayProgram: false }],
			unrecognized: [],
		},
	};
}

describe('the indicative print', () => {
	const day: SettlementDay = { release: V2, window: dayWindow(V2, '2026-11-20') };
	const everySlot = Array.from({ length: day.window.slots }, (_, slot) =>
		roundAt(new Date(day.window.start.getTime() + slot * 300_000)),
	);

	it('computes the ET day from v1-collected rounds across both UTC partitions', () => {
		const print = buildIndicativePrint(day, everySlot, ADMISSION);
		expect(print).toMatchObject({
			schema: 'adi.daily-print/2',
			date: '2026-11-20',
			standing: 'indicative',
			day: 'America/New_York',
			window: { start: '2026-11-20T05:00:00.000Z', end: '2026-11-21T05:00:00.000Z' },
			freezesAt: '2026-11-21T05:30:00.000Z',
			methodologyVersion: '2.0.0',
			coverage: { slotsPerDay: 288, validRounds: 288 },
			result: { status: 'final', value: 1440, groundStopValue: 1440 },
		});
		expect(print.rounds[0]?.roundId).toBe('2026-11-20T05:00Z');
		expect(print.rounds.at(-1)?.roundId).toBe('2026-11-21T04:55Z');
		expect(printHashMatches(print)).toBe(true);
	});

	it('hashes its standing, window and admission policy with it', () => {
		const print = buildIndicativePrint(day, everySlot, ADMISSION);
		const narrowed = { ...print, admission: { ...print.admission, accepts: [identityOf(V2)] } };
		expect(printHashMatches(narrowed)).toBe(false);
		expect(indicativePrintSchema.safeParse(narrowed).success).toBe(false);
	});

	it('suspends on any round outside its admission, naming what it admits', () => {
		const foreign = { methodologyVersion: '9.9.9', parameterHash: 'ef'.repeat(32) };
		const rounds = [...everySlot.slice(0, -1), roundAt(new Date('2026-11-21T04:55:00Z'), foreign)];
		const print = buildIndicativePrint(day, rounds, ADMISSION);
		expect(print.result).toEqual({
			status: 'suspended',
			reason: `mixed methodology: 1 under 9.9.9 (${'ef'.repeat(32)}), not 1.0.0 (${V1.parameterHash}) or 2.0.0 (${V2.parameterHash}); a day settles under one methodology`,
		});
	});

	it('refuses a stored indicative print that misstates its day', () => {
		const print = buildIndicativePrint(day, everySlot, ADMISSION);
		const issues = (value: unknown) =>
			indicativePrintSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];
		expect(
			issues({ ...print, window: { ...print.window, start: '2026-11-20T00:00:00.000Z' } }),
		).toEqual(['window is not the one 2.0.0 gives 2026-11-20']);
		expect(issues({ ...print, freezesAt: '2026-11-21T00:30:00.000Z' })).toEqual([
			'freezesAt is not the one 2.0.0 gives 2026-11-20',
		]);
		expect(
			issues({ ...print, methodologyVersion: '1.0.0', parameterHash: V1.parameterHash }),
		).toEqual(['adi.daily-print/2 holds zoned days; 1.0.0 uses UTC days']);
		expect(issues({ ...print, standing: 'settlement' })).toHaveLength(1);
		expect(issues({ ...print, day: 'UTC' })).toHaveLength(1);
		expect(issues({ ...print, coverage: { ...print.coverage, slotsPerDay: 276 } })).toEqual([
			'coverage.slotsPerDay is 276, but 2026-11-20 has 288 slots',
		]);
		const { day: zone, ...undated } = print;
		expect(indicativePrintSchema.safeParse(undated).success).toBe(false);
		// An impossible date is a validation failure, never a throw.
		expect(indicativePrintSchema.safeParse({ ...print, date: '2026-02-30' }).success).toBe(false);
	});

	it('is deterministic: the same rounds in any order give the same bytes', () => {
		const a = buildIndicativePrint(day, everySlot, ADMISSION);
		const b = buildIndicativePrint(day, [...everySlot].reverse(), ADMISSION);
		expect(canonicalJson(a)).toBe(canonicalJson(b));
	});
});
