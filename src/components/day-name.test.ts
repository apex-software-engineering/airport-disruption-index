import { describe, expect, it } from 'vitest';

import { METHODOLOGY_V1, METHODOLOGY_V2 } from '@/lib/index/releases';

import { dayName } from './day-name';

describe('dayName', () => {
	it('names each release’s day from its own boundary', () => {
		expect(dayName(METHODOLOGY_V1)).toBe('UTC day');
		expect(dayName(METHODOLOGY_V2)).toBe('America/New_York day');
	});
});
