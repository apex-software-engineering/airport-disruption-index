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

/**
 * Every indicative admission policy, pinned by value and never derived from the registry's order,
 * so inserting or reordering a release can never widen what an indicative day admits. Keyed by
 * the exact release (version and parameter hash) whose days it computes: v2 only, which admits
 * its own rounds and v1's, whose receipts are identical to v2's (same source, panel and checks).
 */
const INDICATIVE_POLICIES: readonly { release: Identity; admission: IndicativeAdmission }[] = [
	{
		release: {
			methodologyVersion: '2.0.0',
			parameterHash: 'a9fa10889b35417090d909d4f60d9cb9b429a9703d1b626c1c0a95182b7a76e6',
		},
		admission: {
			policy: INDICATIVE_ADMISSION_POLICY,
			accepts: [
				{
					methodologyVersion: '1.0.0',
					parameterHash: 'e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363',
				},
				{
					methodologyVersion: '2.0.0',
					parameterHash: 'a9fa10889b35417090d909d4f60d9cb9b429a9703d1b626c1c0a95182b7a76e6',
				},
			],
		},
	},
];

/**
 * The admission policy of an indicative release, or null for a release with none. Matched on the
 * exact identity: a release that kept v2's version but changed a parameter has no policy.
 */
export function indicativeAdmissionFor(release: Methodology): IndicativeAdmission | null {
	const { methodologyVersion, parameterHash } = identityOf(release);
	const pinned = INDICATIVE_POLICIES.find(
		(policy) =>
			policy.release.methodologyVersion === methodologyVersion &&
			policy.release.parameterHash === parameterHash,
	);
	return pinned?.admission ?? null;
}

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
	if (indicativeAdmissionFor(successor) === null) return null;
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

/**
 * Whether the indicative series is public: its release's notice has shipped
 * (`noticePublishedAt`). Until then no indicative day is served, shown or frozen by a settle run,
 * and none is frozen into production. This is the only place that decides it.
 */
export function indicativeSeriesPublished(): boolean {
	return indicativeSeriesPublishedIn(RELEASES);
}

/** `indicativeSeriesPublished` over a given registry. */
export function indicativeSeriesPublishedIn(releases: readonly Methodology[]): boolean {
	return releases.some(
		(release) => indicativeAdmissionFor(release) !== null && release.noticePublishedAt !== null,
	);
}

/** Why the indicative API answers 404 before the series is public. */
export const INDICATIVE_UNPUBLISHED = 'the indicative series is not yet published';
