import { describe, expect, it } from 'vitest';

import { DAY, invalidRound, validRange, validRound } from '@/test/rounds';

import { aggregateDay, settledStatus } from './day';
import { dayStartMs } from './time';

const END = new Date(dayStartMs(DAY) + 86_400_000);
const settle = (rounds: Parameters<typeof aggregateDay>[1]) => aggregateDay(DAY, rounds, END);

describe('airport-minutes', () => {
	it('counts 5 minutes per active panel airport per slot, capped at 1440 per airport', () => {
		const day = settle(
			validRange(0, 288, [
				{ airport: 'ATL', gs: true },
				{ airport: 'EWR', gdp: true },
			]),
		);
		expect(day.value).toBe(2880);
		expect(day.groundStopValue).toBe(1440);
		expect(day.airports.find((a) => a.airport === 'ATL')).toEqual({
			airport: 'ATL',
			airportMinutes: 1440,
			groundStopMinutes: 1440,
		});
		expect(day.airports.find((a) => a.airport === 'EWR')).toMatchObject({
			airportMinutes: 1440,
			groundStopMinutes: 0,
		});
	});

	it('counts an airport with both a GS and a GDP once per slot', () => {
		const day = settle([validRound(0, [{ airport: 'LGA', gs: true, gdp: true }]), validRound(1)]);
		expect([day.value, day.groundStopValue]).toEqual([5, 5]);
	});

	it('reaches the 28,800 maximum with all 20 airports active all day', () => {
		const all = aggregateDay(DAY, [], END).airports.map((a) => ({ airport: a.airport, gs: true }));
		expect(settle(validRange(0, 288, all)).value).toBe(28_800);
	});

	it('splits minutes into UTC hours that sum to the total', () => {
		const day = settle([
			...validRange(0, 12, [{ airport: 'ORD', gs: true }]),
			validRound(150, [{ airport: 'ORD', gdp: true }]),
		]);
		expect(day.hourly).toHaveLength(24);
		expect(day.hourly[0]).toMatchObject({
			hourStart: '2026-11-17T00:00:00.000Z',
			airportMinutes: 60,
			groundStopMinutes: 60,
			observed: 12,
		});
		// slot 150 plus the two slots it carries into, all in hour 12
		expect(day.hourly[12]).toMatchObject({
			airportMinutes: 15,
			groundStopMinutes: 0,
			observed: 1,
			carried: 2,
		});
		expect(day.hourly.reduce((sum, h) => sum + h.airportMinutes, 0)).toBe(day.value);
	});
});

describe('carry/suspend ladder', () => {
	const atl = [{ airport: 'ATL' as const, gs: true }];

	it('carries the last valid state for two slots, then contributes nothing', () => {
		const day = settle([validRound(10, atl), validRound(14)]);
		expect(day.slots.slice(10, 15).map((s) => s.status)).toEqual([
			'observed',
			'carried',
			'carried',
			'missing',
			'observed',
		]);
		expect(day.slots[12]).toMatchObject({
			status: 'carried',
			fromRoundId: '2026-11-17T00:50Z',
			slotsCarried: 2,
		});
		expect(day.value).toBe(15);
	});

	it('treats an invalid round like a missing one', () => {
		const day = settle([validRound(10, atl), invalidRound(11), invalidRound(12), invalidRound(13)]);
		expect(day.slots.slice(11, 14).map((s) => s.status)).toEqual(['carried', 'carried', 'missing']);
		expect(day.value).toBe(15);
	});

	it('carries an all-clear state too', () => {
		const day = settle([validRound(10), invalidRound(11)]);
		expect(day.slots[11]).toMatchObject({ status: 'carried', active: [] });
	});

	it('does not count carried slots toward coverage', () => {
		const day = settle([validRound(10, atl)]);
		expect(day.coverage).toMatchObject({
			validRounds: 1,
			carriedSlots: 2,
			missingSlots: 285,
			pendingSlots: 0,
		});
	});

	it('does not carry across the UTC day boundary', () => {
		const day = settle([validRound(287, atl)]);
		expect(day.slots[0]).toEqual({ status: 'missing' });
		expect(day.value).toBe(5);
	});

	it('leaves slots that have not ended as pending, not missing', () => {
		const asOf = new Date(dayStartMs(DAY) + 20 * 300_000 + 30_000); // 30 s into slot 20
		const day = aggregateDay(DAY, [validRound(17, atl)], asOf);
		expect(day.slots.slice(17, 22).map((s) => s.status)).toEqual([
			'observed',
			'carried',
			'carried',
			'pending',
			'pending',
		]);
		expect(day.coverage.pendingSlots).toBe(268);
		const observedNow = aggregateDay(DAY, [validRound(17, atl), validRound(20, atl, 10)], asOf);
		expect(observedNow.slots[20]).toMatchObject({ status: 'observed' });
		expect(observedNow.value).toBe(20);
	});
});

describe('one round per slot', () => {
	it('rejects two rounds for one slot: the archive keeps one receipt per round id', () => {
		expect(() => settle([validRound(5, [], 1), invalidRound(5, 100)])).toThrow(/two rounds/);
	});

	it('rejects rounds from another day or methodology', () => {
		const other = { ...validRound(0), roundId: '2026-11-18T00:00Z' };
		expect(() => settle([other])).toThrow(/not on 2026-11-17/);
		const oldMethod = { ...validRound(0), methodologyVersion: '0.9.0' };
		expect(() => settle([oldMethod])).toThrow(/methodology/);
	});
});

describe('settled status thresholds', () => {
	it.each([
		[288, 'final'],
		[274, 'final'], // 95.14%
		[273, 'degraded'], // 94.79%
		[231, 'degraded'], // 80.21%
		[230, 'suspended'], // 79.86%
		[0, 'suspended'],
	])('%i valid rounds -> %s', (valid, status) => {
		expect(settledStatus(valid)).toBe(status);
	});

	it('reports coverage percent from valid rounds only', () => {
		expect(settle(validRange(0, 274)).coverage.percent).toBe(95.14);
	});
});
