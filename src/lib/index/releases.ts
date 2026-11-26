/**
 * Every released methodology, oldest first. A release's parameters are never edited once
 * published: a change is a new entry with a new version and a new parameter hash (pinned in
 * methodology.test.ts). Older entries stay so that their days keep settling, validating and
 * reproducing under the parameters they were collected under.
 *
 * The schedule fields (`effectiveUntil`, `announcedAt`, `announcedProofAt`, `withdrawn`,
 * `noticePublishedAt`) are not hashed. They change only through the published cutover steps in docs/design/v2-eastern-day.md.
 */
import { hashJson } from './json';
import type { Methodology, MethodologyParameters, ZonedDayParameters } from './methodology';

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

/**
 * v2: the civil day in America/New_York instead of the UTC day. Every other parameter is v1's.
 * Not yet announced (`announcedAt: null`), so it governs no day and collects no round.
 */
export const METHODOLOGY_V2 = {
	version: '2.0.0',
	name: METHODOLOGY_V1.name,
	unit: METHODOLOGY_V1.unit,
	source: METHODOLOGY_V1.source,
	panel: METHODOLOGY_V1.panel,
	day: { timeZone: 'America/New_York' },
	slotMinutes: METHODOLOGY_V1.slotMinutes,
	roundAssignment: METHODOLOGY_V1.roundAssignment,
	quorum: METHODOLOGY_V1.quorum,
	observation: METHODOLOGY_V1.observation,
	programs: METHODOLOGY_V1.programs,
	minutesPerActiveSlot: METHODOLOGY_V1.minutesPerActiveSlot,
	carry: METHODOLOGY_V1.carry,
	coverage: METHODOLOGY_V1.coverage,
	settlement: METHODOLOGY_V1.settlement,
} as const satisfies ZonedDayParameters;

type Schedule = Partial<
	Pick<
		Methodology,
		'effectiveUntil' | 'announcedAt' | 'announcedProofAt' | 'withdrawn' | 'noticePublishedAt'
	>
>;

export function release(
	parameters: MethodologyParameters,
	effectiveFrom: string,
	schedule: Schedule = {},
): Methodology {
	return {
		parameters,
		parameterHash: hashJson(parameters),
		effectiveFrom,
		effectiveUntil: schedule.effectiveUntil ?? null,
		announcedAt: schedule.announcedAt ?? null,
		announcedProofAt: schedule.announcedProofAt ?? null,
		withdrawn: schedule.withdrawn ?? false,
		noticePublishedAt: schedule.noticePublishedAt ?? null,
	};
}

/**
 * v1 covers every day from the first live capture of the feed. v2's notice (cutover step 1,
 * docs/incidents.md) is published at 2026-11-29T00:00Z: from then its indicative series, the
 * `upcoming` block, the banner and the notice's doc passages are public. It is not announced
 * (`announcedAt` null until the readback's N is recorded), so it governs no day yet.
 */
export const RELEASES: readonly Methodology[] = [
	release(METHODOLOGY_V1, '2026-11-17'),
	release(METHODOLOGY_V2, '2027-01-01', { noticePublishedAt: '2026-11-29T00:00:00.000Z' }),
];
