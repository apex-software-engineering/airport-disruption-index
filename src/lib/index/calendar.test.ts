import { describe, expect, it } from 'vitest';

import {
	collectingRelease,
	correctionDeadline,
	dayAt,
	dayWindow,
	effectiveAt,
	labelAt,
	partitionsOf,
	publishBy,
	settlementDay,
	settlesAt,
	slotIndexIn,
	type SettlementDay,
} from './calendar';
import { aggregateDay, settledStatus } from './day';
import { settlementReleaseFor } from './methodology';
import { METHODOLOGY_V1, RELEASES } from './releases';
import type { RoundSummary } from './schemas';
import { addDays, roundIdFor } from './time';

function registered(index: number) {
	const release = RELEASES[index];
	if (release === undefined) throw new Error(`the registry has no release ${index}`);
	return release;
}
const V1 = registered(0);
const V2 = registered(1);

const iso = (date: Date) => date.toISOString();

describe('day windows', () => {
	it('gives a v1 day the UTC day, 288 slots, with the v1 deadlines unchanged', () => {
		const window = dayWindow(V1, '2026-11-20');
		expect([iso(window.start), iso(window.end), window.slots]).toEqual([
			'2026-11-20T00:00:00.000Z',
			'2026-11-21T00:00:00.000Z',
			288,
		]);
		expect(iso(settlesAt(window))).toBe('2026-11-21T00:30:00.000Z');
		expect(iso(publishBy(window))).toBe('2026-11-21T01:30:00.000Z');
		expect(iso(correctionDeadline(settlesAt(window)))).toBe('2026-11-22T00:30:00.000Z');
		expect(partitionsOf(window)).toEqual(['2026-11-20']);
	});

	// The settlement annex's sample days, exactly.
	it.each([
		['2027-03-14', '2027-03-14T05:00:00.000Z', '2027-03-15T04:00:00.000Z', 276],
		['2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 300],
		['2027-11-07', '2027-11-07T04:00:00.000Z', '2027-11-08T05:00:00.000Z', 300],
		['2027-01-01', '2027-01-01T05:00:00.000Z', '2027-01-02T05:00:00.000Z', 288],
	])('gives the v2 day %s the window [%s, %s), %i slots', (label, start, end, slots) => {
		const window = dayWindow(V2, label);
		expect([iso(window.start), iso(window.end), window.slots]).toEqual([start, end, slots]);
		expect(partitionsOf(window)).toEqual([label, addDays(label, 1)]);
	});

	it.each([
		// day, end, settlesAt, publishBy, corrections until, from the design's worked examples
		['2027-01-01', '2027-01-02T05:00', '2027-01-02T05:30', '2027-01-02T06:30', '2027-01-03T05:30'],
		['2027-03-13', '2027-03-14T05:00', '2027-03-14T05:30', '2027-03-14T06:30', '2027-03-15T05:30'],
		['2027-03-14', '2027-03-15T04:00', '2027-03-15T04:30', '2027-03-15T05:30', '2027-03-16T04:30'],
		['2027-11-06', '2027-11-07T04:00', '2027-11-07T04:30', '2027-11-07T05:30', '2027-11-08T04:30'],
		['2027-11-07', '2027-11-08T05:00', '2027-11-08T05:30', '2027-11-08T06:30', '2027-11-09T05:30'],
	])('keeps every v2 deadline a fixed duration after %s ends', (label, end, cutoff, due, until) => {
		const window = dayWindow(V2, label);
		const at = (minute: string) => `${minute}:00.000Z`;
		expect(iso(window.end)).toBe(at(end));
		expect(iso(settlesAt(window))).toBe(at(cutoff));
		expect(iso(publishBy(window))).toBe(at(due));
		expect(iso(correctionDeadline(settlesAt(window)))).toBe(at(until));
	});

	it('tiles every v2 day from 2026 to 2035 with whole slots, one 23 h and one 25 h day a year', () => {
		const lengths = new Map<number, number[]>();
		for (let label = '2026-01-01'; label < '2036-01-01'; label = addDays(label, 1)) {
			const window = dayWindow(V2, label);
			expect(window.end).toEqual(dayWindow(V2, addDays(label, 1)).start);
			expect(window.start.getTime() % 300_000).toBe(0);
			expect(labelAt(V2, window.start)).toBe(label);
			expect(labelAt(V2, new Date(window.end.getTime() - 1))).toBe(label);
			const year = Number(label.slice(0, 4));
			lengths.set(year, [...(lengths.get(year) ?? []), window.slots]);
		}
		for (const slots of lengths.values()) {
			expect(new Set(slots)).toEqual(new Set([276, 288, 300]));
			expect(slots.filter((s) => s === 276)).toHaveLength(1);
			expect(slots.filter((s) => s === 300)).toHaveLength(1);
		}
	});

	it('places a slot by its UTC start, and nowhere outside the window', () => {
		const window = dayWindow(V2, '2027-03-14');
		expect(slotIndexIn(window, window.start)).toBe(0);
		expect(slotIndexIn(window, new Date('2027-03-15T03:55:00Z'))).toBe(275);
		expect(slotIndexIn(window, window.end)).toBeNull();
		expect(slotIndexIn(window, new Date('2027-03-14T04:55:00Z'))).toBeNull();
		expect(slotIndexIn(window, new Date('2027-03-14T05:02:00Z'))).toBeNull();
	});
});

describe('coverage thresholds as percentages of the day', () => {
	it.each([
		[276, 263, 221],
		[288, 274, 231],
		[300, 285, 240],
	])(
		'needs %i slots × 95%% = %i for final and × 80%% = %i for degraded',
		(slots, final, degraded) => {
			const status = (validRounds: number) =>
				settledStatus({ validRounds, slotsPerDay: slots }, METHODOLOGY_V1.coverage);
			expect([status(final), status(final - 1)]).toEqual(['final', 'degraded']);
			expect([status(degraded), status(degraded - 1)]).toEqual(['degraded', 'suspended']);
		},
	);
});

/** A valid all-clear round summary for the slot starting at `slotStart`, recorded under v2. */
function v2Round(slotStart: Date, active: string[] = []): RoundSummary {
	return {
		roundId: roundIdFor(slotStart),
		fetchedAt: new Date(slotStart.getTime() + 3000).toISOString(),
		receiptHash: 'ab'.repeat(32),
		methodologyVersion: V2.parameters.version,
		parameterHash: V2.parameterHash,
		observation: {
			status: 'valid',
			feedUpdateTime: slotStart.toISOString(),
			active: active.map((airport) => ({ airport, groundStop: true, groundDelayProgram: false })),
			unrecognized: [],
		},
	};
}

describe('aggregating a v2 day', () => {
	const dayOf = (label: string): SettlementDay => ({ release: V2, window: dayWindow(V2, label) });
	const everySlot = (day: SettlementDay, active: string[] = []) =>
		Array.from({ length: day.window.slots }, (_, slot) =>
			v2Round(new Date(day.window.start.getTime() + slot * 300_000), active),
		);

	it('has 23 hourly buckets on the spring-forward day and a 27,600 maximum', () => {
		const day = dayOf('2027-03-14');
		const all = V2.parameters.panel.map(String);
		const result = aggregateDay(day, everySlot(day, all), day.window.end);
		expect(result.hourly).toHaveLength(23);
		expect(result.value).toBe(27_600);
		expect(result.coverage).toMatchObject({ slotsPerDay: 276, validRounds: 276, percent: 100 });
	});

	it('has 25 distinct UTC-keyed hourly buckets on the fall-back day', () => {
		const day = dayOf('2027-11-07');
		const result = aggregateDay(day, everySlot(day, ['ATL']), day.window.end);
		expect(result.hourly).toHaveLength(25);
		expect(new Set(result.hourly.map((h) => h.hourStart)).size).toBe(25);
		// 01:00 EDT and 01:00 EST: the repeated local hour is two buckets.
		expect(result.hourly.slice(1, 3).map((h) => h.hourStart)).toEqual([
			'2027-11-07T05:00:00.000Z',
			'2027-11-07T06:00:00.000Z',
		]);
		expect(result.value).toBe(1500);
	});

	it('restarts the carry ladder at ET midnight, not at UTC midnight', () => {
		const day = dayOf('2027-01-05');
		const lastUtcSlot = new Date('2027-01-05T23:55:00Z');
		const result = aggregateDay(day, [v2Round(lastUtcSlot, ['JFK'])], day.window.end);
		// 00:00Z on the 6th is 19:00 ET on the 5th: the same day, so the round carries into it.
		const next = slotIndexIn(day.window, new Date('2027-01-06T00:00:00Z'));
		expect(next).not.toBeNull();
		expect(result.slots[next ?? -1]).toMatchObject({ status: 'carried', slotsCarried: 1 });
		expect(result.slots[0]).toMatchObject({ status: 'missing' });
	});

	it('refuses a round from outside the day', () => {
		const day = dayOf('2027-01-05');
		expect(() =>
			aggregateDay(day, [v2Round(new Date('2027-01-05T04:55:00Z'))], day.window.end),
		).toThrow(/not on 2027-01-05/);
	});
});

describe('the registry before v2 is announced', () => {
	it('keeps v2 registered and hashed but governing nothing: v1 owns every day', () => {
		expect(V2.announcedAt).toBeNull();
		expect(V1.effectiveUntil).toBeNull();
		for (const label of ['2026-12-31', '2027-01-01', '2027-03-14', '2030-06-01']) {
			expect(settlementReleaseFor(label)).toBe(V1);
			expect(settlementDay(label).window.slots).toBe(288);
		}
	});

	it('maps every instant to its v1 UTC day, with no transition, and collects under v1', () => {
		for (const at of ['2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z', '2027-01-01T04:59:59Z']) {
			const instant = new Date(at);
			const day = dayAt(instant);
			expect(day.kind).toBe('day');
			if (day.kind === 'day') expect(day.release).toBe(V1);
			expect(collectingRelease(instant)).toBe(V1);
		}
	});

	it('dates v2 taking effect at 00:00Z of its first date, the end of v1’s last day', () => {
		expect(iso(effectiveAt(V1))).toBe('2026-11-17T00:00:00.000Z');
		expect(iso(effectiveAt(V2))).toBe('2027-01-01T00:00:00.000Z');
	});

	it('has no day before the first release', () => {
		expect(() => dayAt(new Date('2026-11-16T23:59:59Z'))).toThrow(/no methodology/);
		expect(() => collectingRelease(new Date('2026-11-16T23:59:59Z'))).toThrow(/no methodology/);
	});
});
