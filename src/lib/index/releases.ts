/**
 * Every released methodology, oldest first. A release is never edited once published: a change
 * is a new entry with a new version, a new parameter hash (pinned in methodology.test.ts) and an
 * `effectiveFrom` day at least one day after it ships. Older entries stay so that their days
 * keep settling, validating and reproducing under the parameters they were collected under.
 */
import { hashJson } from './json';
import type { Methodology, MethodologyParameters } from './methodology';

export const METHODOLOGY_V1 = {
	version: '1.0.0',
	name: 'Airport Disruption Index',
	unit: 'airport-minutes',
	source: {
		id: 'faa-nas-status-airport-status-information',
		url: 'https://nasstatus.faa.gov/api/airport-status-information',
		format: 'xml',
	},
	/** Top 20 of the FAA Core 30 by CY2024 enplanements, FAA 3-letter codes, rank order. */
	panel: [
		'ATL',
		'DFW',
		'DEN',
		'ORD',
		'LAX',
		'JFK',
		'CLT',
		'LAS',
		'MCO',
		'MIA',
		'PHX',
		'SEA',
		'SFO',
		'EWR',
		'IAH',
		'BOS',
		'MSP',
		'FLL',
		'LGA',
		'DTW',
	],
	day: 'utc',
	slotMinutes: 5,
	slotsPerDay: 288,
	roundAssignment: 'first-valid-observation-per-slot',
	quorum: 1,
	observation: {
		requireHttpStatus: 200,
		maxFeedAgeSeconds: 900,
		maxFeedLeadSeconds: 120,
	},
	programs: {
		headline: ['ground_stop', 'ground_delay_program'],
		groundStopOnly: ['ground_stop'],
	},
	minutesPerActiveSlot: 5,
	carry: {
		maxCarriedSlots: 2,
		crossesDayBoundary: false,
	},
	coverage: {
		finalMinPercent: 95,
		degradedMinPercent: 80,
	},
	settlement: {
		cutoffMinutesAfterDayEnd: 30,
		revisions: 'correction-prints-only',
	},
} as const satisfies MethodologyParameters;

export function release(parameters: MethodologyParameters, effectiveFrom: string): Methodology {
	return { parameters, parameterHash: hashJson(parameters), effectiveFrom };
}

/** v1 covers every day from the first live capture of the feed. */
export const RELEASES: readonly Methodology[] = [release(METHODOLOGY_V1, '2026-11-17')];
