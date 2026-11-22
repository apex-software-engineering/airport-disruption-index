/**
 * Published data shapes. Each one is a zod schema so that anything read back from storage or
 * from the public API is validated before use; the TypeScript types are inferred from them.
 */
import { z } from 'zod';

import { adapterOf } from './adapters';
import { correctionDeadline, dayWindow, settlesAt } from './calendar';
import { INDICATIVE_ADMISSION_POLICY, indicativeAdmissionFor } from './indicative';
import { canonicalJson } from './json';
import { methodologyOf, type Methodology } from './methodology';
import { parseRoundId, parseUtcDate } from './time';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime();
/** An FAA 3-letter code. Which codes form the panel depends on the recorded methodology. */
const panelAirport = z.string().regex(/^[A-Z]{3}$/);
const count = z.number().int().nonnegative();
export const roundIdSchema = z
	.string()
	.refine((id) => parseRoundId(id) !== null, 'invalid round id');
export const utcDateSchema = z.string().refine((d) => parseUtcDate(d) !== null, 'invalid UTC date');

export const programEventSchema = z.discriminatedUnion('program', [
	z.object({
		program: z.literal('ground_stop'),
		airport: z.string().min(1),
		reason: z.string().nullable(),
		endTime: z.string().nullable(),
	}),
	z.object({
		program: z.literal('ground_delay_program'),
		airport: z.string().min(1),
		reason: z.string().nullable(),
		average: z.string().nullable(),
		maximum: z.string().nullable(),
	}),
]);
export type ProgramEvent = z.infer<typeof programEventSchema>;

/** A Delay_type list that v1 parses but does not count. */
export const otherDelayTypeSchema = z.object({
	disposition: z.enum(['ignored', 'unrecognized']),
	name: z.string().nullable(),
	element: z.string().nullable(),
	entries: count,
});
export type OtherDelayType = z.infer<typeof otherDelayTypeSchema>;

/** Which list an `unrecognized` Delay_type entry was: its element and its block's Name. */
export const unrecognizedListSchema = otherDelayTypeSchema.pick({ name: true, element: true });
export type UnrecognizedList = z.infer<typeof unrecognizedListSchema>;

export const airportStateSchema = z.object({
	airport: panelAirport,
	groundStop: z.boolean(),
	groundDelayProgram: z.boolean(),
});
export type AirportState = z.infer<typeof airportStateSchema>;

/**
 * Checks a stored object against the methodology it records: the release must be one this code
 * knows, and `rows` (when given) must list that release's panel in panel order. Validating
 * against the recorded release, not the current one, keeps archived objects readable after a
 * later release changes the panel. Returns the recorded release, or null when it is unknown.
 */
function checkRecordedMethodology(
	recorded: { methodologyVersion: string; parameterHash: string },
	rows: readonly { airport: string }[] | null,
	ctx: z.RefinementCtx,
): Methodology | null {
	const { methodologyVersion, parameterHash } = recorded;
	const methodology = methodologyOf(methodologyVersion, parameterHash);
	if (methodology === null) {
		ctx.addIssue({
			code: 'custom',
			message: `methodology ${methodologyVersion} (${parameterHash}) is not a known release`,
			path: ['methodologyVersion'],
		});
		return null;
	}
	const { panel } = methodology.parameters;
	if (
		rows !== null &&
		!(rows.length === panel.length && rows.every((r, i) => r.airport === panel[i]))
	) {
		ctx.addIssue({
			code: 'custom',
			message: `must list every airport of the ${methodologyVersion} panel in panel order`,
		});
	}
	return methodology;
}

export const invalidReasonSchema = z.enum([
	'network_error',
	'http_status',
	'parse_error',
	/**
	 * Adapter faa-nas-xml/2 onward: the root holds an element the feed has never carried, or a
	 * counted-program block does not hold exactly one of its own list.
	 */
	'unrecognized_structure',
	'stale_feed',
	'feed_ahead_of_clock',
]);
export type InvalidReason = z.infer<typeof invalidReasonSchema>;

export const observationSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('valid'),
		feedUpdateTime: instant,
		events: z.array(programEventSchema),
		otherDelayTypes: z.array(otherDelayTypeSchema),
		/** One entry per panel airport of the recorded methodology, in panel order. */
		panel: z.array(airportStateSchema),
	}),
	z.object({
		status: z.literal('invalid'),
		reason: invalidReasonSchema,
		detail: z.string(),
		feedUpdateTime: instant.nullable(),
	}),
]);
export type Observation = z.infer<typeof observationSchema>;

/**
 * A receipt's shape alone, without the checks against the release and adapter it records. Only
 * for reading a receipt that records a release this code may not know, to list it as foreign;
 * anything counted is parsed with `receiptSchema`.
 */
export const receiptShapeSchema = z.object({
	schema: z.literal('adi.round-receipt/1'),
	roundId: roundIdSchema,
	slotStart: instant,
	fetchedAt: instant,
	sourceUrl: z.url(),
	/**
	 * The source adapter that fetched and parsed this round (adapters.ts). Absent on receipts
	 * written before the field existed, which keeps their receiptHash unchanged; those were all
	 * produced by the first adapter.
	 */
	adapterVersion: z.string().optional(),
	methodologyVersion: z.string(),
	parameterHash: hex64,
	/** null when no HTTP response arrived. */
	httpStatus: z.number().int().nullable(),
	/** sha256 of the response body bytes as received; null when there was no response. */
	rawSha256: hex64.nullable(),
	rawBytes: count.nullable(),
	observation: observationSchema,
	receiptHash: hex64,
});

export const receiptSchema = receiptShapeSchema.superRefine((receipt, ctx) => {
	checkRecordedMethodology(
		receipt,
		receipt.observation.status === 'valid' ? receipt.observation.panel : null,
		ctx,
	);
	if (adapterOf(receipt.adapterVersion) === null) {
		ctx.addIssue({
			code: 'custom',
			message: `feed adapter ${receipt.adapterVersion} is not a known adapter`,
			path: ['adapterVersion'],
		});
	}
});
export type RoundReceipt = z.infer<typeof receiptSchema>;

/** The part of a receipt the index math needs. Day index blobs store these. */
export const roundSummarySchema = z.object({
	roundId: roundIdSchema,
	fetchedAt: instant,
	receiptHash: hex64,
	methodologyVersion: z.string(),
	parameterHash: hex64,
	observation: z.discriminatedUnion('status', [
		z.object({
			status: z.literal('valid'),
			feedUpdateTime: instant,
			/** Panel airports with at least one active program. */
			active: z.array(airportStateSchema),
			/**
			 * The round's `unrecognized` Delay_type lists, which never count but are flagged. Day
			 * indexes written before this field existed read as none; settlement rebuilds the index
			 * from receipts, so the gap is limited to that one day's earlier rounds and never
			 * reaches a print.
			 */
			unrecognized: z.array(unrecognizedListSchema).default([]),
		}),
		z.object({ status: z.literal('invalid'), reason: invalidReasonSchema }),
	]),
});
export type RoundSummary = z.infer<typeof roundSummarySchema>;

export const dayIndexSchema = z.object({
	schema: z.literal('adi.day-index/1'),
	date: utcDateSchema,
	rounds: z.array(roundSummarySchema),
});
export type DayIndex = z.infer<typeof dayIndexSchema>;

export const airportMinutesSchema = z.object({
	airport: panelAirport,
	airportMinutes: count,
	groundStopMinutes: count,
});
export type AirportMinutes = z.infer<typeof airportMinutesSchema>;

export const hourSchema = z.object({
	hourStart: instant,
	airportMinutes: count,
	groundStopMinutes: count,
	observed: count,
	carried: count,
	missing: count,
	pending: count,
});
export type HourBucket = z.infer<typeof hourSchema>;

export const coverageSchema = z.object({
	slotsPerDay: count,
	validRounds: count,
	carriedSlots: count,
	missingSlots: count,
	pendingSlots: count,
	/** validRounds / slotsPerDay as a percent, rounded to 2 decimals (display only). */
	percent: z.number().nonnegative(),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const settledStatusSchema = z.enum(['final', 'degraded', 'suspended']);
export type SettledStatus = z.infer<typeof settledStatusSchema>;

const statedText = (what: string) => z.string().regex(/\S/, what);

/** Why a revision supersedes another, and when the operator issued it (correctDay in archive.ts). */
export const correctionSchema = z.object({
	supersedesPrintHash: hex64,
	reason: statedText('a correction states its reason'),
	/** When the operator issued this revision. Attestation deadlines count from it. */
	issuedAt: instant,
	/** Why it was issued after the corrections window closed; null when issued inside it. */
	windowOverride: statedText('a window override states its justification').nullable(),
});
export type Correction = z.infer<typeof correctionSchema>;

/**
 * An `adi.daily-print/1` print is a UTC day: its recorded release must use the UTC day boundary,
 * and its `settlesAt` must be that day's cutoff. Returns the cutoff, which every deadline is
 * computed from, so a print can never move its own corrections window by stating another time.
 */
function checkUtcDay(
	print: { date: string; settlesAt: string },
	release: Methodology,
	ctx: z.RefinementCtx,
): Date | null {
	if (release.parameters.day !== 'utc') {
		ctx.addIssue({
			code: 'custom',
			message: `adi.daily-print/1 holds UTC days only; ${release.parameters.version} uses ${release.parameters.day.timeZone} days`,
			path: ['methodologyVersion'],
		});
		return null;
	}
	// An impossible date is reported by the date refinement; there is no cutoff to compare.
	if (parseUtcDate(print.date) === null) return null;
	const cutoff = settlesAt(dayWindow(release, print.date));
	if (print.settlesAt !== cutoff.toISOString()) {
		ctx.addIssue({
			code: 'custom',
			message: `settlesAt is ${print.settlesAt}, but ${print.date} settles at ${cutoff.toISOString()}`,
			path: ['settlesAt'],
		});
		return null;
	}
	return cutoff;
}

/** A correction is issued after its day settles, and after the window only with a justification. */
function checkCorrectionTiming(
	print: { correction: Correction | null },
	cutoff: Date,
	ctx: z.RefinementCtx,
): void {
	const { correction } = print;
	if (correction === null) return;
	const issuedAt = new Date(correction.issuedAt);
	if (issuedAt < cutoff) {
		ctx.addIssue({
			code: 'custom',
			message: `issued at ${correction.issuedAt}, before the day settled at ${cutoff.toISOString()}`,
			path: ['correction', 'issuedAt'],
		});
	}
	const deadline = correctionDeadline(cutoff);
	if (issuedAt >= deadline !== (correction.windowOverride !== null)) {
		ctx.addIssue({
			code: 'custom',
			message: `the corrections window closed at ${deadline.toISOString()}: a correction issued after it records a windowOverride justification, and one issued before it records none`,
			path: ['correction', 'windowOverride'],
		});
	}
}

/** A computed day's result: the value and breakdowns, or for a suspended day only the reason. */
const dayResultSchema = z.discriminatedUnion('status', [
	z.object({
		status: z.enum(['final', 'degraded']),
		value: count,
		groundStopValue: count,
		airports: z.array(airportMinutesSchema),
		hourly: z.array(hourSchema),
	}),
	z.object({ status: z.literal('suspended'), reason: z.string() }),
]);

/** Every round a print was computed from, valid and invalid, with its receipt hash. */
const printRoundsSchema = z.array(
	z.object({
		roundId: roundIdSchema,
		receiptHash: hex64,
		status: z.enum(['valid', 'invalid']),
	}),
);

export const printSchema = z
	.object({
		schema: z.literal('adi.daily-print/1'),
		date: utcDateSchema,
		revision: z.number().int().min(1),
		/** null on revision 1, which settlement issues; every later revision is a correction. */
		correction: correctionSchema.nullable(),
		methodologyVersion: z.string(),
		parameterHash: hex64,
		settlesAt: instant,
		coverage: coverageSchema,
		result: dayResultSchema,
		rounds: printRoundsSchema,
		printHash: hex64,
	})
	.refine((print) => (print.revision === 1) === (print.correction === null), {
		message: 'revision 1 has no correction; every later revision is a correction',
	})
	.superRefine((print, ctx) => {
		const release = checkRecordedMethodology(
			print,
			print.result.status === 'suspended' ? null : print.result.airports,
			ctx,
		);
		if (release === null) return;
		const cutoff = checkUtcDay(print, release, ctx);
		if (cutoff !== null) checkCorrectionTiming(print, cutoff, ctx);
	});
export type DailyPrint = z.infer<typeof printSchema>;

export const identitySchema = z.object({ methodologyVersion: z.string(), parameterHash: hex64 });

/**
 * An indicative print (design §4): an America/New_York day computed under v2 from archived
 * receipts before v2 takes effect. Its standing, window and admission policy are hashed with it,
 * so it can never pass as a settlement print. Never revised, so it has no revision.
 */
export const indicativePrintSchema = z
	.object({
		schema: z.literal('adi.daily-print/2'),
		date: z.string().refine((d) => parseUtcDate(d) !== null, 'invalid date'),
		standing: z.literal('indicative'),
		/** The zone the date is read in, hashed with the print. */
		day: z.literal('America/New_York'),
		window: z.object({ start: instant, end: instant }),
		/** When it was built: the day's end plus the settlement cutoff, after admission closed. */
		freezesAt: instant,
		admission: z.object({
			policy: z.literal(INDICATIVE_ADMISSION_POLICY),
			accepts: z.array(identitySchema).min(1),
		}),
		methodologyVersion: z.string(),
		parameterHash: hex64,
		coverage: coverageSchema,
		result: dayResultSchema,
		rounds: printRoundsSchema,
		printHash: hex64,
	})
	.superRefine((print, ctx) => {
		const release = checkRecordedMethodology(
			print,
			print.result.status === 'suspended' ? null : print.result.airports,
			ctx,
		);
		if (release !== null) checkIndicativeDay(print, release, ctx);
	});
export type IndicativePrint = z.infer<typeof indicativePrintSchema>;

/**
 * An indicative print states exactly its release's day: the window and freeze time `dayWindow`
 * computes for its date, and the release's own admission policy. Anything else is refused, so a
 * reader never needs tz data to trust what a print covers.
 */
function checkIndicativeDay(
	print: Pick<IndicativePrint, 'date' | 'day' | 'window' | 'freezesAt' | 'admission'>,
	release: Methodology,
	ctx: z.RefinementCtx,
): void {
	if (parseUtcDate(print.date) === null) return;
	if (release.parameters.day === 'utc') {
		ctx.addIssue({
			code: 'custom',
			message: `adi.daily-print/2 holds zoned days; ${release.parameters.version} uses UTC days`,
			path: ['methodologyVersion'],
		});
		return;
	}
	const admission = indicativeAdmissionFor(release);
	if (admission === null) {
		ctx.addIssue({
			code: 'custom',
			message: `${release.parameters.version} has no indicative series`,
			path: ['methodologyVersion'],
		});
		return;
	}
	const window = dayWindow(release, print.date);
	const expected = {
		day: release.parameters.day.timeZone,
		window: { start: window.start.toISOString(), end: window.end.toISOString() },
		freezesAt: settlesAt(window).toISOString(),
		admission,
	};
	for (const field of ['day', 'window', 'freezesAt', 'admission'] as const) {
		if (canonicalJson(print[field]) !== canonicalJson(expected[field])) {
			ctx.addIssue({
				code: 'custom',
				message: `${field} is not the one ${release.parameters.version} gives ${print.date}`,
				path: [field],
			});
		}
	}
}

export const historyEntrySchema = z.object({
	date: utcDateSchema,
	revision: z.number().int().min(1),
	status: settledStatusSchema,
	value: count.nullable(),
	groundStopValue: count.nullable(),
	coveragePercent: z.number().nonnegative(),
	printHash: hex64,
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyIndexSchema = z.object({
	schema: z.literal('adi.history/1'),
	days: z.array(historyEntrySchema),
});
export type HistoryIndex = z.infer<typeof historyIndexSchema>;

/** A full git commit id, as `git rev-parse HEAD` prints it. */
export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * A settled print pinned outside the operator's storage: committed to the public repo and stamped
 * with OpenTimestamps by the attest workflow. `deployedCommit` is what the API reported when the
 * day was attested; null means the deployment could not say.
 */
export const attestationSchema = z.object({
	schema: z.literal('adi.attestation/1'),
	date: utcDateSchema,
	revision: z.number().int().min(1),
	printHash: hex64,
	roundsDigest: hex64,
	parameterHash: hex64,
	methodologyVersion: z.string(),
	deployedCommit: commitShaSchema.nullable(),
});
export type Attestation = z.infer<typeof attestationSchema>;
