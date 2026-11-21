/**
 * The methodology registry's types and lookups. Every released methodology lives in
 * releases.ts with the UTC day it takes effect; nothing else in the code holds parameters.
 *
 * - A day is computed under the methodology in effect on that day (`methodologyFor`).
 * - A stored receipt or print is validated and rebuilt under the methodology it records
 *   (`methodologyOf`), so a later release never changes how an archived object is read.
 */
import { RELEASES } from './releases';
import type { UtcDate } from './time';

export type Program = 'ground_stop' | 'ground_delay_program';

/**
 * Every parameter that can change a published number. The parameter hash is the sha256 of this
 * object's canonical JSON. The slot grid and settlement timing are literal types: every release
 * shares them, because round ids, slots and cutoffs are the same for every version.
 */
export type MethodologyParameters = {
	readonly version: string;
	readonly name: string;
	readonly unit: string;
	readonly source: { readonly id: string; readonly url: string; readonly format: 'xml' };
	/** FAA 3-letter codes, in rank order. */
	readonly panel: readonly string[];
	readonly day: 'utc';
	readonly slotMinutes: 5;
	readonly slotsPerDay: 288;
	readonly roundAssignment: 'first-valid-observation-per-slot';
	readonly quorum: 1;
	readonly observation: {
		readonly requireHttpStatus: number;
		/** Update_Time may be at most this old at fetch time. */
		readonly maxFeedAgeSeconds: number;
		/** Update_Time may be at most this far ahead of fetch time (clock disagreement). */
		readonly maxFeedLeadSeconds: number;
	};
	readonly programs: {
		readonly headline: readonly Program[];
		readonly groundStopOnly: readonly Program[];
	};
	/** Airport-minutes an active panel airport contributes per slot, at most once per slot. */
	readonly minutesPerActiveSlot: number;
	readonly carry: {
		/** A missing or invalid slot carries the last valid state for at most this many slots. */
		readonly maxCarriedSlots: number;
		readonly crossesDayBoundary: false;
	};
	readonly coverage: {
		/** Coverage = valid rounds / slotsPerDay, compared in integer percent. */
		readonly finalMinPercent: number;
		readonly degradedMinPercent: number;
	};
	readonly settlement: {
		readonly cutoffMinutesAfterDayEnd: 30;
		readonly revisions: 'correction-prints-only';
	};
};

/** A released methodology: its parameters, their hash, and the first UTC day it applies to. */
export type Methodology = {
	readonly parameters: MethodologyParameters;
	readonly parameterHash: string;
	/** Takes effect at 00:00Z of this day and applies until the next release's day. */
	readonly effectiveFrom: UtcDate;
};

/** The grid every release shares (see the literal types above). */
export const SLOT_MINUTES: MethodologyParameters['slotMinutes'] = 5;
export const SLOTS_PER_DAY: MethodologyParameters['slotsPerDay'] = 288;
export const SETTLEMENT_CUTOFF_MINUTES: MethodologyParameters['settlement']['cutoffMinutesAfterDayEnd'] = 30;

/** The methodology in effect on `date`, or null for a day before the first release. */
export function methodologyInEffect(date: UtcDate): Methodology | null {
	return RELEASES.findLast((r) => r.effectiveFrom <= date) ?? null;
}

/** The methodology in effect on `date`, for a day that must have one (it has rounds). */
export function methodologyFor(date: UtcDate): Methodology {
	const release = methodologyInEffect(date);
	if (release === null) throw new Error(`no methodology is in effect on ${date}`);
	return release;
}

/** The release a stored object records, or null when this code does not know it. */
export function methodologyOf(version: string, parameterHash: string): Methodology | null {
	return (
		RELEASES.find((r) => r.parameters.version === version && r.parameterHash === parameterHash) ??
		null
	);
}

/** Whether an object recording `recorded` was produced under `methodology`. */
export function isUnder(
	methodology: Methodology,
	recorded: { methodologyVersion: string; parameterHash: string },
): boolean {
	return (
		recorded.methodologyVersion === methodology.parameters.version &&
		recorded.parameterHash === methodology.parameterHash
	);
}
