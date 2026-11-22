import { describe, expect, it } from 'vitest';

import { correctionOf, DAY, invalidRound, validRange, validRound } from '@/test/rounds';

import { dayWindow, settlementDay } from './calendar';
import { hashJson } from './json';
import { buildPrint, historyEntryOf, printHashMatches } from './print';
import { METHODOLOGY_V2, RELEASES } from './releases';
import { printSchema, type Correction } from './schemas';

const issuesOf = (value: unknown) =>
	printSchema.safeParse(value).error?.issues.map((issue) => issue.message) ?? [];

const rounds = [
	...validRange(0, 280, [{ airport: 'JFK', gs: true }]),
	invalidRound(280),
	validRound(281),
];

describe('buildPrint', () => {
	it('builds a valid, hashed, final print listing every receipt', () => {
		const print = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		expect(printSchema.parse(print)).toEqual(print);
		expect(printHashMatches(print)).toBe(true);
		expect(print.settlesAt).toBe('2026-11-18T00:30:00.000Z');
		expect(print.correction).toBeNull();
		expect(print.result).toMatchObject({ status: 'final', value: 1405, groundStopValue: 1405 });
		expect(print.coverage).toMatchObject({ validRounds: 281, carriedSlots: 3, missingSlots: 4 });
		expect(print.rounds).toHaveLength(282);
		expect(print.rounds[280]).toMatchObject({ roundId: '2026-11-17T23:20Z', status: 'invalid' });
	});

	it('does not depend on the order rounds are supplied in', () => {
		const a = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const b = buildPrint(settlementDay(DAY), [...rounds].reverse(), { revision: 1 });
		expect(b.printHash).toBe(a.printHash);
	});

	it('publishes no value for a suspended day', () => {
		const print = buildPrint(
			settlementDay(DAY),
			validRange(0, 230, [{ airport: 'JFK', gs: true }]),
			{ revision: 1 },
		);
		expect(print.result).toEqual({
			status: 'suspended',
			reason: 'coverage 230/288 valid rounds is below 80%',
		});
		expect(historyEntryOf(print)).toMatchObject({
			status: 'suspended',
			value: null,
			groundStopValue: null,
		});
	});

	it('suspends a day that mixes methodologies, whatever its coverage, instead of throwing', () => {
		const old = validRange(0, 10).map((round) => ({ ...round, methodologyVersion: '0.9.0' }));
		const print = buildPrint(
			settlementDay(DAY),
			[...old, ...validRange(10, 288, [{ airport: 'JFK', gs: true }])],
			{ revision: 1 },
		);
		expect(print.result.status).toBe('suspended');
		expect(print.result).toMatchObject({
			reason: expect.stringMatching(
				/^mixed methodology: 10 under 0\.9\.0 \([0-9a-f]{64}\), not 1\.0\.0/,
			),
		});
		// Every round is still listed, so the suspended print is reproducible from the archive.
		expect(print.rounds).toHaveLength(288);
		expect(print.coverage.validRounds).toBe(278);
		expect(printHashMatches(print)).toBe(true);
	});

	it('marks a degraded day but still publishes its value', () => {
		const print = buildPrint(settlementDay(DAY), validRange(0, 250), { revision: 1 });
		expect(print.result).toMatchObject({ status: 'degraded', value: 0 });
	});

	it('requires a correction to supersede a print and give a reason', () => {
		const original = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const correction = correctionOf(
			original.printHash,
			'receipts for 23:20Z onward were written by a misconfigured deployment',
		);
		expect(
			buildPrint(settlementDay(DAY), rounds.slice(0, 200), { revision: 2, correction }).correction,
		).toEqual(correction);
		expect(() =>
			buildPrint(settlementDay(DAY), rounds, {
				revision: 2,
				correction: { ...correction, reason: ' ' },
			}),
		).toThrow();
	});

	it('keeps a correction inside its window unless the print records why', () => {
		const original = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const at = (issuedAt: string, windowOverride: string | null = null) =>
			printSchema.safeParse(
				buildUnchecked({ ...correctionOf(original.printHash), issuedAt, windowOverride }),
			).success;
		// The window runs from the settlement cutoff (D+1 00:30Z) to D+2 00:30Z.
		expect(at('2026-11-18T00:29:59.999Z')).toBe(false);
		expect(at('2026-11-18T00:30:00.000Z')).toBe(true);
		expect(at('2026-11-19T00:29:59.999Z')).toBe(true);
		expect(at('2026-11-19T00:30:00.000Z')).toBe(false);
		expect(at('2026-11-19T00:30:00.000Z', 'feed outage confirmed by the FAA on D+2')).toBe(true);
		expect(at('2026-11-19T00:30:00.000Z', ' ')).toBe(false);
		expect(at('2026-11-18T12:00:00.000Z', 'not needed inside the window')).toBe(false);
	});

	it('takes the corrections window from the day, never from a settlesAt the print states', () => {
		const original = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const late = buildUnchecked({
			...correctionOf(original.printHash),
			issuedAt: '2026-11-19T06:00:00.000Z',
			windowOverride: null,
		});
		// As on main: after D+2 00:30Z a correction needs an override...
		expect(printSchema.safeParse(late).success).toBe(false);
		// ...and stating a later settlesAt cannot move the window to fit it.
		const shifted = { ...late, settlesAt: '2026-11-18T12:00:00.000Z' };
		expect(issuesOf(shifted)).toEqual([
			'settlesAt is 2026-11-18T12:00:00.000Z, but 2026-11-17 settles at 2026-11-18T00:30:00.000Z',
		]);
		expect(printSchema.safeParse({ ...original, settlesAt: shifted.settlesAt }).success).toBe(
			false,
		);
	});

	it('reports an impossible date as a validation failure, without throwing', () => {
		const print = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const result = printSchema.safeParse({ ...print, date: '2026-02-30' });
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => issue.message)).toEqual(['invalid UTC date']);
	});

	it('holds UTC days only: a /1 print recording the America/New_York release is refused', () => {
		const print = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		const zoned = {
			...print,
			methodologyVersion: '2.0.0',
			parameterHash: hashJson(METHODOLOGY_V2),
		};
		expect(issuesOf(zoned)).toEqual([
			'adi.daily-print/1 holds UTC days only; 2.0.0 uses America/New_York days',
		]);
	});

	it('holds a zoned settlement day as /2, stating and checking its standing, zone and window', () => {
		const v2 = RELEASES[1];
		if (v2 === undefined) throw new Error('the registry lists v2');
		const day = { release: v2, window: dayWindow(v2, '2027-01-05') };
		const print = buildPrint(day, [], { revision: 1 });
		if (print.schema !== 'adi.daily-print/2') throw new Error('a zoned day is a /2 print');
		expect(print).toMatchObject({
			schema: 'adi.daily-print/2',
			standing: 'settlement',
			day: 'America/New_York',
			window: { start: '2027-01-05T05:00:00.000Z', end: '2027-01-06T05:00:00.000Z' },
			settlesAt: '2027-01-06T05:30:00.000Z',
		});
		expect(
			issuesOf({ ...print, window: { ...print.window, start: '2027-01-05T00:00:00.000Z' } }),
		).toEqual(['window is not the one 2.0.0 gives 2027-01-05']);
		expect(issuesOf({ ...print, settlesAt: '2027-01-06T00:30:00.000Z' })).toEqual([
			'settlesAt is 2027-01-06T00:30:00.000Z, but 2027-01-05 settles at 2027-01-06T05:30:00.000Z',
		]);
		// An indicative print, or a /2 print recording v1, is never a settlement print.
		expect(printSchema.safeParse({ ...print, standing: 'indicative' }).success).toBe(false);
		const v1 = settlementDay(DAY).release;
		expect(
			issuesOf({ ...print, methodologyVersion: '1.0.0', parameterHash: v1.parameterHash }),
		).toEqual(['adi.daily-print/2 holds zoned days; 1.0.0 uses UTC days']);
	});

	it('detects a tampered print', () => {
		const print = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		expect(printHashMatches({ ...print, revision: 2 })).toBe(false);
	});

	it('rejects a stored print whose revision and correction disagree', () => {
		const print = buildPrint(settlementDay(DAY), rounds, { revision: 1 });
		expect(printSchema.safeParse({ ...print, revision: 2 }).success).toBe(false);
		expect(
			printSchema.safeParse({ ...print, correction: correctionOf(print.printHash) }).success,
		).toBe(false);
	});
});

/** A revision-2 print with `correction`, as stored, without buildPrint's validation. */
function buildUnchecked(correction: Correction) {
	const valid = buildPrint(settlementDay(DAY), rounds, {
		revision: 2,
		correction: correctionOf('0'.repeat(64)),
	});
	return { ...valid, correction };
}
