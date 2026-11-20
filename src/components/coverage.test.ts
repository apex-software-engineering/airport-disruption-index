import { describe, expect, it } from 'vitest';

import { describeCoverage, type TodayCoverage } from './coverage';

// 00:05:30 UTC: slot 0 has ended, slot 1 is open and already holds its valid round.
const earlyMorning: TodayCoverage = {
	slotsPerDay: 288,
	validRounds: 2,
	carriedSlots: 0,
	missingSlots: 0,
	pendingSlots: 286,
	percent: 0.69,
	elapsedSlots: 1,
};

describe('describeCoverage', () => {
	it('words coverage against the whole day, with ended slots counted apart', () => {
		expect(describeCoverage(earlyMorning)).toEqual({
			percent: '0.69%',
			observed: '2 of 288 slots observed',
			slots: '2 observed, 0 carried, 0 missing, 286 pending',
			ended: '1 of 288 slots ended',
		});
	});

	it('refuses slot counts that do not cover the day', () => {
		expect(() => describeCoverage({ ...earlyMorning, pendingSlots: 285 })).toThrow(
			/add up to 287, not 288/,
		);
	});
});
