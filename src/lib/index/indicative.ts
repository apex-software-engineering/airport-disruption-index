/**
 * The indicative ET series (design §4): v2's day, computed from the same archived receipts for
 * every day before v2 takes effect. Never a settlement value. This module owns which release an
 * indicative day is computed under (chosen by label, never by what is in effect) and the hashed
 * admission policy that lets its rounds, collected under v1, count.
 */
import { dayWindow, settlesAt } from './calendar';
import { identityOf, type Identity, type Methodology } from './methodology';
import { RELEASES } from './releases';
import { addDays, utcDateOf } from './time';

export const INDICATIVE_ADMISSION_POLICY = 'adi.indicative-admission/1' as const;

/** ET day 2026-11-20 starts at 05:00Z, after the first production round (04:30Z): full collection. */
export const FIRST_INDICATIVE_DAY = '2026-11-20';

/** How the series is named wherever it is shown, so its zone and standing always travel with it. */
export const INDICATIVE_SERIES = {
	headline: 'ADI (ET, indicative)',
	groundStopOnly: 'ADI-GS (ET, indicative)',
} as const;

/** Which recorded identities an indicative day admits. Embedded in, and hashed with, every print. */
export type IndicativeAdmission = {
	readonly policy: typeof INDICATIVE_ADMISSION_POLICY;
	readonly accepts: readonly Identity[];
};

/** The only release with an indicative series: v2, whose receipts are identical to v1's. */
const INDICATIVE_VERSIONS: ReadonlySet<string> = new Set(['2.0.0']);

/**
 * The release an indicative day `label` is computed under, chosen by label: the release
 * registered right after the last one whose `effectiveFrom` is on or before `label`. It answers
 * the same before v2 is announced, after it is announced, and after it takes effect, so the last
 * day before the cutover still freezes once v2 is in effect. Null when that release has no
 * indicative series, when `label` is before the first indicative day, or when the release is
 * withdrawn (which ends the series; `includeWithdrawn` keeps published prints reproducible).
 */
export function indicativeReleaseIn(
	releases: readonly Methodology[],
	label: string,
	options: { includeWithdrawn: boolean },
): Methodology | null {
	if (label < FIRST_INDICATIVE_DAY) return null;
	const owner = releases.findLastIndex((release) => release.effectiveFrom <= label);
	const successor = releases[owner + 1];
	if (owner < 0 || successor === undefined) return null;
	if (!INDICATIVE_VERSIONS.has(successor.parameters.version)) return null;
	if (successor.withdrawn && !options.includeWithdrawn) return null;
	return successor;
}

/** `indicativeReleaseIn` over the registry: the indicative release for `label`, if any. */
export function indicativeReleaseFor(
	label: string,
	options = { includeWithdrawn: false },
): Methodology | null {
	return indicativeReleaseIn(RELEASES, label, options);
}

/**
 * The admission policy of an indicative release: exactly its own identity and that of the release
 * it replaces, whose receipts it would have written byte for byte (same source, panel and checks).
 * Null for a release with no indicative series.
 */
export function indicativeAdmissionFor(release: Methodology): IndicativeAdmission | null {
	const predecessor = RELEASES[RELEASES.indexOf(release) - 1];
	if (predecessor === undefined || !INDICATIVE_VERSIONS.has(release.parameters.version))
		return null;
	return {
		policy: INDICATIVE_ADMISSION_POLICY,
		accepts: [identityOf(predecessor), identityOf(release)],
	};
}

/** When the indicative print of `label` may be frozen: its day's end plus the settlement cutoff. */
export function indicativeFreezesAt(release: Methodology, label: string): Date {
	return settlesAt(dayWindow(release, label));
}

/**
 * The indicative days dated within the `lookbackDays` UTC dates before `now` whose freeze time
 * has passed, oldest first: what a settle run freezes if it is not frozen yet.
 */
export function dueIndicativeDays(now: Date, lookbackDays: number): string[] {
	const today = utcDateOf(now);
	return Array.from({ length: lookbackDays }, (_, i) => addDays(today, i - lookbackDays)).filter(
		(label) => {
			const release = indicativeReleaseFor(label);
			return release !== null && indicativeFreezesAt(release, label) <= now;
		},
	);
}
