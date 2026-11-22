import { describe, expect, it } from 'vitest';

import {
	formatLocal,
	formatLocalHour,
	formatLocalRange,
	formatUtc,
	formatUtcHour,
	isUtcOffsetZero,
} from './format';

describe('formatUtc and formatUtcHour', () => {
	it('render the canonical UTC value', () => {
		expect(formatUtc('2026-11-19T14:05:31.000Z')).toBe('2026-11-19 14:05:31 UTC');
		expect(formatUtcHour('2026-11-19T14:00:00.000Z')).toBe('14:00');
	});

	it('refuse a string that is not an instant', () => {
		expect(() => formatUtc('not a time')).toThrow('not an instant');
	});
});

describe('formatLocal', () => {
	it('gives the local time, date and zone abbreviation', () => {
		expect(formatLocal('2026-11-22T00:30:00.000Z', 'America/New_York')).toBe('Nov 21, 7:30 PM EST');
		expect(formatLocal('2026-11-22T00:30:00.000Z', 'Asia/Tokyo')).toBe('Nov 22, 9:30 AM GMT+9');
		expect(formatLocal('2026-11-22T00:30:00.000Z', 'UTC')).toBe('Nov 22, 12:30 AM UTC');
	});

	it('follows the zone across the end of daylight saving time', () => {
		// US DST ended 2026-11-01 at 02:00 EDT (06:00Z): 1:30 AM happened twice that night.
		expect(formatLocal('2026-11-01T05:30:00.000Z', 'America/New_York')).toBe('Nov 1, 1:30 AM EDT');
		expect(formatLocal('2026-11-01T06:30:00.000Z', 'America/New_York')).toBe('Nov 1, 1:30 AM EST');
	});

	it('refuses a string that is not an instant', () => {
		expect(() => formatLocal('2026-13-01', 'America/New_York')).toThrow('not an instant');
	});
});

describe('formatLocalRange', () => {
	it('gives the local stretch a UTC day covers', () => {
		expect(
			formatLocalRange('2026-11-21T00:00:00.000Z', '2026-11-22T00:00:00.000Z', 'America/Chicago'),
		).toBe('Nov 20, 6:00 PM CST – Nov 21, 6:00 PM CST');
	});

	it('marks each end with its own abbreviation on a DST change day', () => {
		// The UTC day is 24 hours; the local clock falls back an hour inside it, so it reads 23.
		expect(
			formatLocalRange('2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'America/New_York'),
		).toBe('Oct 31, 8:00 PM EDT – Nov 1, 7:00 PM EST');
	});

	it('keeps both offsets when both ends fall on the same local date', () => {
		// The Azores fell back from UTC+0 to UTC-1 at 01:00Z on 2026-10-25, so that UTC day is
		// Oct 25 at both ends locally. Intl's formatRange would print the start without its offset.
		expect(
			formatLocalRange('2026-10-25T00:00:00.000Z', '2026-10-26T00:00:00.000Z', 'Atlantic/Azores'),
		).toBe('Oct 25, 12:00 AM GMT+0 – Oct 25, 11:00 PM GMT-1');
	});
});

describe('formatLocalHour', () => {
	it('drops the minutes on the hour and keeps them off it', () => {
		expect(formatLocalHour('2026-11-22T00:00:00.000Z', 'America/Chicago')).toBe('6 PM');
		expect(formatLocalHour('2026-11-22T00:00:00.000Z', 'Asia/Kolkata')).toBe('5:30 AM');
		expect(formatLocalHour('2026-11-22T12:00:00.000Z', 'UTC')).toBe('12 PM');
	});
});

describe('isUtcOffsetZero', () => {
	it('is true only where local time repeats UTC at that instant', () => {
		expect(isUtcOffsetZero('2026-07-22T00:30:00.000Z', 'UTC')).toBe(true);
		expect(isUtcOffsetZero('2026-11-22T00:30:00.000Z', 'Europe/London')).toBe(true);
		expect(isUtcOffsetZero('2026-07-22T00:30:00.000Z', 'Europe/London')).toBe(false);
		expect(isUtcOffsetZero('2026-11-22T00:30:00.000Z', 'America/New_York')).toBe(false);
	});
});
