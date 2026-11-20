import { hashJson } from './json';

/**
 * Methodology v1. Every parameter that can change a published number lives here, and the
 * parameter hash is the sha256 of this object's canonical JSON. Changing any value is a
 * methodology release: bump `version` and pin the new hash in methodology.test.ts.
 */
export const METHODOLOGY = {
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
		/** Update_Time may be at most this old at fetch time. */
		maxFeedAgeSeconds: 900,
		/** Update_Time may be at most this far ahead of fetch time (clock disagreement). */
		maxFeedLeadSeconds: 120,
	},
	programs: {
		headline: ['ground_stop', 'ground_delay_program'],
		groundStopOnly: ['ground_stop'],
	},
	/** Airport-minutes an active panel airport contributes per slot, at most once per slot. */
	minutesPerActiveSlot: 5,
	carry: {
		/** A missing or invalid slot carries the last valid state for at most this many slots. */
		maxCarriedSlots: 2,
		crossesDayBoundary: false,
	},
	coverage: {
		/** Coverage = valid rounds / slotsPerDay, compared in integer percent. */
		finalMinPercent: 95,
		degradedMinPercent: 80,
	},
	settlement: {
		cutoffMinutesAfterDayEnd: 30,
		revisions: 'correction-prints-only',
	},
} as const;

export type Methodology = typeof METHODOLOGY;
export type MethodologyVersion = Methodology['version'];
export type PanelAirport = Methodology['panel'][number];
export type Program = Methodology['programs']['headline'][number];

export const PANEL: readonly PanelAirport[] = METHODOLOGY.panel;
export const PARAMETER_HASH: string = hashJson(METHODOLOGY);

export function isPanelAirport(code: string): code is PanelAirport {
	return PANEL.some((airport) => airport === code);
}
