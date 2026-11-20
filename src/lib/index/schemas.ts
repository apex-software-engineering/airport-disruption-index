/**
 * Published data shapes. Each one is a zod schema so that anything read back from storage or
 * from the public API is validated before use; the TypeScript types are inferred from them.
 */
import { z } from 'zod';

import { METHODOLOGY, PANEL } from './methodology';
import { parseRoundId, parseUtcDate } from './time';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime();
const panelAirport = z.enum(METHODOLOGY.panel);
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

export const airportStateSchema = z.object({
	airport: panelAirport,
	groundStop: z.boolean(),
	groundDelayProgram: z.boolean(),
});
export type AirportState = z.infer<typeof airportStateSchema>;

/** One entry per panel airport, in panel order. */
const panelStateSchema = z
	.array(airportStateSchema)
	.refine(
		(rows) => rows.length === PANEL.length && rows.every((row, i) => row.airport === PANEL[i]),
		'panel state must list every panel airport in panel order',
	);

export const invalidReasonSchema = z.enum([
	'network_error',
	'http_status',
	'parse_error',
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
		panel: panelStateSchema,
	}),
	z.object({
		status: z.literal('invalid'),
		reason: invalidReasonSchema,
		detail: z.string(),
		feedUpdateTime: instant.nullable(),
	}),
]);
export type Observation = z.infer<typeof observationSchema>;

export const receiptSchema = z.object({
	schema: z.literal('adi.round-receipt/1'),
	roundId: roundIdSchema,
	slotStart: instant,
	fetchedAt: instant,
	sourceUrl: z.url(),
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

export const printSchema = z.object({
	schema: z.literal('adi.daily-print/1'),
	date: utcDateSchema,
	revision: z.number().int().min(1),
	correction: z.object({ supersedesPrintHash: hex64, reason: z.string().min(1) }).nullable(),
	methodologyVersion: z.string(),
	parameterHash: hex64,
	settlesAt: instant,
	coverage: coverageSchema,
	result: z.discriminatedUnion('status', [
		z.object({
			status: z.enum(['final', 'degraded']),
			value: count,
			groundStopValue: count,
			airports: z.array(airportMinutesSchema),
			hourly: z.array(hourSchema),
		}),
		z.object({ status: z.literal('suspended'), reason: z.string() }),
	]),
	rounds: z.array(
		z.object({ roundId: roundIdSchema, receiptHash: hex64, status: z.enum(['valid', 'invalid']) }),
	),
	printHash: hex64,
});
export type DailyPrint = z.infer<typeof printSchema>;

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
