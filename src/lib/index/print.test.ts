import { describe, expect, it } from 'vitest';

import { DAY, invalidRound, validRange, validRound } from '@/test/rounds';

import { buildPrint, historyEntryOf, printHashMatches } from './print';
import { printSchema } from './schemas';

const rounds = [
	...validRange(0, 280, [{ airport: 'JFK', gs: true }]),
	invalidRound(280),
	validRound(281),
];

describe('buildPrint', () => {
	it('builds a valid, hashed, final print listing every receipt', () => {
		const print = buildPrint(DAY, rounds, { revision: 1 });
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
		const a = buildPrint(DAY, rounds, { revision: 1 });
		const b = buildPrint(DAY, [...rounds].reverse(), { revision: 1 });
		expect(b.printHash).toBe(a.printHash);
	});

	it('publishes no value for a suspended day', () => {
		const print = buildPrint(DAY, validRange(0, 230, [{ airport: 'JFK', gs: true }]), {
			revision: 1,
		});
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

	it('marks a degraded day but still publishes its value', () => {
		const print = buildPrint(DAY, validRange(0, 250), { revision: 1 });
		expect(print.result).toMatchObject({ status: 'degraded', value: 0 });
	});

	it('requires a correction to supersede a print and give a reason', () => {
		const original = buildPrint(DAY, rounds, { revision: 1 });
		const correction = buildPrint(DAY, rounds.slice(0, 200), {
			revision: 2,
			supersedesPrintHash: original.printHash,
			reason: 'receipts for 23:20Z onward were written by a misconfigured deployment',
		});
		expect(correction.correction).toEqual({
			supersedesPrintHash: original.printHash,
			reason: 'receipts for 23:20Z onward were written by a misconfigured deployment',
		});
		expect(() =>
			buildPrint(DAY, rounds, {
				revision: 1,
				supersedesPrintHash: original.printHash,
				reason: 'x',
			}),
		).toThrow();
		expect(() =>
			buildPrint(DAY, rounds, {
				revision: 2,
				supersedesPrintHash: original.printHash,
				reason: ' ',
			}),
		).toThrow();
	});

	it('detects a tampered print', () => {
		const print = buildPrint(DAY, rounds, { revision: 1 });
		expect(printHashMatches({ ...print, revision: 2 })).toBe(false);
	});
});
