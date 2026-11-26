import { describe, expect, it } from 'vitest';

import { niceCeiling, ticksTo } from './chart-scale';

describe('niceCeiling', () => {
	it('rounds up to 1, 2, 2.5 or 5 times a power of ten', () => {
		expect([1, 7, 120, 2300, 2600, 9001].map(niceCeiling)).toEqual([1, 10, 200, 2500, 5000, 10000]);
	});

	it('gives an empty chart a scale of its own', () => {
		expect(niceCeiling(0)).toBe(60);
	});
});

describe('ticksTo', () => {
	it('adds a middle gridline only where it is a whole number', () => {
		expect(ticksTo(2500)).toEqual([0, 1250, 2500]);
		expect(ticksTo(25)).toEqual([0, 25]);
	});
});
