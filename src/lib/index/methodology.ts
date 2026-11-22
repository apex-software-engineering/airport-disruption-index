/**
 * The methodology registry's types and label lookups. Every released methodology lives in
 * releases.ts with the days it governs; nothing else in the code holds parameters. Instants (which
 * release collects a round, which day an instant belongs to) are resolved in calendar.ts.
 *
 * - A settlement day is computed under the release that owns its label (`settlementReleaseFor`).
 * - A stored receipt or print is validated and rebuilt under the release it records
 *   (`methodologyOf`), so a later release never changes how an archived object is read.
 */
import { RELEASES } from './releases';

export type Program = 'ground_stop' | 'ground_delay_program';

/** The only zone a day boundary other than UTC may use. */
export type DayTimeZone = 'America/New_York';

/**
 * Every parameter that can change a published number, shared by all releases. The parameter hash
 * is the sha256 of the release's full parameter object in canonical JSON. The slot grid and the
 * settlement cutoff are literal types: round ids, slots and cutoffs are the same for every version.
 */
type CommonParameters = {
	readonly version: string;
	readonly name: string;
	readonly unit: string;
	readonly source: { readonly id: string; readonly url: string; readonly format: 'xml' };
	/** FAA 3-letter codes, in rank order. */
	readonly panel: readonly string[];
	readonly slotMinutes: 5;
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
		/** Coverage = valid rounds / the day's slots, compared in integer percent. */
		readonly finalMinPercent: number;
		readonly degradedMinPercent: number;
	};
	readonly settlement: {
		readonly cutoffMinutesAfterDayEnd: 30;
		readonly revisions: 'correction-prints-only';
	};
};

/** v1: the UTC day, always 288 slots. Its hashed object is frozen, so its shape is too. */
export type UtcDayParameters = CommonParameters & {
	readonly day: 'utc';
	readonly slotsPerDay: 288;
};

/** A civil day in an IANA zone: 276, 288 or 300 slots, so no slot count is a parameter. */
export type ZonedDayParameters = CommonParameters & {
	readonly day: { readonly timeZone: DayTimeZone };
};

export type MethodologyParameters = UtcDayParameters | ZonedDayParameters;

/** A day label, `YYYY-MM-DD`, read in its release's day boundary (UTC for v1). */
export type DayLabel = string;

/** A released methodology: its parameters, their hash, and the days it governs. */
export type Methodology = {
	readonly parameters: MethodologyParameters;
	readonly parameterHash: string;
	/** Its first day. It takes effect at 00:00Z of this date (settlement rule 4). */
	readonly effectiveFrom: DayLabel;
	/** Its last day, inclusive, once a successor's cutover is activated; null while open. */
	readonly effectiveUntil: DayLabel | null;
	/** N: when its announcement was first publicly read back. Null until recorded. */
	readonly announcedAt: string | null;
	/** Set only by a withdrawal notice. A withdrawn release is never in effect. */
	readonly withdrawn: boolean;
};

/** The grid every release shares (see the literal types above). */
export const SLOT_MINUTES: MethodologyParameters['slotMinutes'] = 5;
export const SETTLEMENT_CUTOFF_MINUTES: MethodologyParameters['settlement']['cutoffMinutesAfterDayEnd'] = 30;

/**
 * Whether a release governs any days. The first release always does; a later one only once its
 * announcement is recorded (`announcedAt`), and never once withdrawn. Until then it is registered,
 * hashed and readable, but no day, round or deadline uses it.
 */
export function isActive(release: Methodology): boolean {
	if (release.withdrawn) return false;
	return release === RELEASES[0] || release.announcedAt !== null;
}

/** The active releases, oldest first. */
export function activeReleases(): Methodology[] {
	return RELEASES.filter(isActive);
}

/** Whether `label` is one of the days `release` governs. */
export function governs(release: Methodology, label: DayLabel): boolean {
	return (
		label >= release.effectiveFrom &&
		(release.effectiveUntil === null || label <= release.effectiveUntil)
	);
}

/** The active release that owns `label` as a settlement day, or null when none does. */
export function settlementReleaseOrNull(label: DayLabel): Methodology | null {
	return activeReleases().find((release) => governs(release, label)) ?? null;
}

/** The active release that owns `label` as a settlement day, for a day that must have one. */
export function settlementReleaseFor(label: DayLabel): Methodology {
	const release = settlementReleaseOrNull(label);
	if (release === null) throw new Error(`no methodology is in effect on ${label}`);
	return release;
}

/** The release a stored object records, or null when this code does not know it. */
export function methodologyOf(version: string, parameterHash: string): Methodology | null {
	return (
		RELEASES.find((r) => r.parameters.version === version && r.parameterHash === parameterHash) ??
		null
	);
}

/** The version and parameter hash a receipt or print records. */
export type Identity = { readonly methodologyVersion: string; readonly parameterHash: string };

export function identityOf(methodology: Methodology): Identity {
	return {
		methodologyVersion: methodology.parameters.version,
		parameterHash: methodology.parameterHash,
	};
}

/** Whether `recorded` is exactly one of the `admitted` identities. */
export function admits(admitted: readonly Identity[], recorded: Identity): boolean {
	return admitted.some(
		(identity) =>
			identity.methodologyVersion === recorded.methodologyVersion &&
			identity.parameterHash === recorded.parameterHash,
	);
}

/** Whether an object recording `recorded` was produced under `methodology`. */
export function isUnder(methodology: Methodology, recorded: Identity): boolean {
	return admits([identityOf(methodology)], recorded);
}
