/**
 * The both-ways proof of an indicative ET day (design §4): the frozen print rebuilds from the
 * public API, and the set of `(roundId, receiptHash)` pairs it lists equals, exactly, the pairs the
 * reference v1 prints of its UTC days list inside its window, invalid receipts included. Nothing
 * may be omitted and nothing added.
 *
 * Each UTC day's reference is its latest revision that verifies on its own: attested, its print
 * matching its attestation, and its proof in a Bitcoin block before that revision's cutoff. An
 * unattested, pending or late revision is simply not a reference; a day with none yet makes the
 * result PENDING, never MATCH. Receipts are final after admission, so every served revision of a
 * day must list the same receipts: one that does not is a MISMATCH, as is any conflict between the
 * branch and the API. Both UTC days are always checked, so a MISMATCH on either wins over the
 * other's PENDING or could-not-verify.
 *
 * Every ordinary indicative day's window lies in UTC days D and D+1, both v1 settlement days.
 * E−1, whose window ends in the cutover's transition interval, has its own branch with the gap pin
 * (design §4, D8): its one v1 reference covers the slots before the gap, and the pin the gap.
 */
import {
	activatedCutoverInto,
	dayWindow,
	partitionsOf,
	type Cutover,
	type Interval,
} from '@/lib/index/calendar';
import { indicativeReleaseFor } from '@/lib/index/indicative';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import type { DailyPrint, RoundSummary } from '@/lib/index/schemas';
import { addDays, parseRoundId, type UtcDate } from '@/lib/index/time';
import {
	CannotVerify,
	Mismatch,
	fetchPublication,
	fetchSettledDay,
	reproduceIndicativeDay,
	type Get,
} from '@/lib/reproduce';

import { proveRevisions, type BranchCheckout, type RevisionProof } from './attestations';
import { gapOf, readTransitionPin, type GapRound } from './transition-pin';

export type IndicativeProof =
	| { kind: 'match'; log: string[] }
	| { kind: 'mismatch'; log: string[]; problems: string[] }
	/**
	 * The rebuild matches, but a reference is not verified yet: a v1 reference (no set comparison
	 * has run), or for E−1 the gap pin's proof (after the covered slots compared equal).
	 */
	| { kind: 'pending'; log: string[]; reason: string }
	/**
	 * E−1 only: the covered slots are equal both ways and the gap pin is absent. `unpinned` are the
	 * gap receipts the print lists, which the pin would hold.
	 */
	| { kind: 'partial'; log: string[]; cutover: Cutover; unpinned: GapRound[] }
	| { kind: 'cannot_verify'; log: string[]; reason: string };

/** A listed receipt as both sides are compared: its round and its hash. */
type Pair = { roundId: string; key: string };

function pairsOf(rounds: readonly Pick<RoundSummary, 'roundId' | 'receiptHash'>[]): Pair[] {
	return rounds.map(({ roundId, receiptHash }) => ({ roundId, key: `${roundId} ${receiptHash}` }));
}

/**
 * Proves indicative ET day `label` against the attestations branch checked out at `checkout`.
 *
 * The last indicative day of a release, E−1 (`effectiveFrom − 1`), takes its own branch: its
 * window ends in the activated cutover's transition interval, which no v1 print covers. Its
 * covered slots are compared both ways against its one v1 reference first, so a missing or
 * pending pin never hides a mismatch there; only then is the gap compared against the pin.
 */
export async function proveIndicativeDay(
	label: UtcDate,
	baseUrl: string,
	checkout: BranchCheckout,
	get: Get,
	clock: () => Date,
): Promise<IndicativeProof> {
	const rebuilt = await reproduceIndicativeDay(label, baseUrl, get, clock);
	const { log } = rebuilt.outcome;
	if (rebuilt.outcome.kind === 'mismatch') {
		return { kind: 'mismatch', log, problems: rebuilt.outcome.problems };
	}
	if (rebuilt.outcome.kind === 'cannot_verify') {
		return { kind: 'cannot_verify', log, reason: rebuilt.outcome.reason };
	}
	const release = indicativeReleaseFor(label, { includeWithdrawn: true });
	if (rebuilt.print === null || release === null) {
		return { kind: 'cannot_verify', log, reason: `${label} has no indicative print to prove` };
	}
	// The print's own window: its schema already checked it is this one (rebuilt above).
	const window = dayWindow(release, label);
	let cutover: Cutover | null = null;
	if (label === addDays(release.effectiveFrom, -1)) {
		cutover = activatedCutoverInto(release);
		if (cutover === null) {
			return {
				kind: 'cannot_verify',
				log,
				reason: `${label} is the last indicative day before ${release.parameters.version}, whose cutover is not activated: its transition interval is not derived yet`,
			};
		}
		const gap = gapOf(cutover);
		if (window.end.getTime() !== gap.end.getTime() || gap.start <= window.start) {
			throw new Error(
				`${label}'s window does not end in the transition interval [${gap.start.toISOString()}, ${gap.end.toISOString()})`,
			);
		}
	}
	const gap = cutover === null ? null : gapOf(cutover);
	/** The part of the window the v1 references cover: all of it, or for E−1 up to the gap. */
	const covered: Interval = { start: window.start, end: gap?.start ?? window.end };
	const references = partitionsOf(covered);
	const unowned = references.find(
		(date) => settlementReleaseOrNull(date)?.parameters.day !== 'utc',
	);
	if (unowned !== undefined) {
		return {
			kind: 'cannot_verify',
			log,
			reason: `${label}'s window reaches ${unowned}, which is no v1 UTC day`,
		};
	}
	const results: Reference[] = [];
	for (const date of references)
		results.push(await verifiedReference(date, baseUrl, checkout, get, clock));
	const mismatches = results.flatMap((result) =>
		result.kind === 'mismatch' ? result.problems : [],
	);
	if (mismatches.length > 0) return { kind: 'mismatch', log, problems: mismatches };
	const unchecked = results.flatMap((result) =>
		result.kind === 'cannot_verify' ? [result.reason] : [],
	);
	if (unchecked.length > 0) return { kind: 'cannot_verify', log, reason: unchecked.join('; ') };
	const unverified = results.flatMap((result) =>
		result.kind === 'pending' ? [result.reason] : [],
	);
	if (unverified.length > 0) return { kind: 'pending', log, reason: unverified.join('; ') };
	const reference = new Map<string, string>();
	for (const result of results.filter((r): r is VerifiedReference => r.kind === 'verified')) {
		log.push(...result.lines);
		for (const pair of result.pairs) {
			if (inInterval(covered, pair.roundId)) reference.set(pair.key, result.named);
		}
	}
	const listed = rebuilt.print.rounds;
	const inGap = (roundId: string) => gap !== null && inInterval(gap, roundId);
	const indicative = new Set(
		pairsOf(listed.filter((round) => !inGap(round.roundId))).map((pair) => pair.key),
	);
	const problems = differences(
		reference,
		indicative,
		(key, named) => `${named} lists ${key}, which the indicative print of ${label} omits`,
		(key) => `the indicative print of ${label} lists ${key}, which no verified v1 reference lists`,
	);
	if (problems.length > 0) return { kind: 'mismatch', log, problems };
	const what = gap === null ? 'receipts' : 'receipts in the covered slots';
	log.push(
		`indicative ${label}: ${indicative.size} ${what}, equal both ways to the verified v1 references (${references.join(', ')})`,
	);
	if (cutover === null || gap === null) return { kind: 'match', log };
	const gapRounds = listed.filter((round) => inGap(round.roundId));
	const pin = await readTransitionPin(checkout, cutover);
	switch (pin.kind) {
		case 'absent':
			log.push(
				`gap [${gap.start.toISOString()}, ${gap.end.toISOString()}): ${gapRounds.length} receipts unpinned, ${pin.name} is not on the branch`,
				...gapRounds.map(
					(round) => `unpinned ${round.roundId} ${round.receiptHash} ${round.status}`,
				),
			);
			return { kind: 'partial', log, cutover, unpinned: gapRounds };
		case 'mismatch':
			return { kind: 'mismatch', log, problems: pin.problems.map((p) => `gap pin: ${p}`) };
		case 'pending':
			return {
				kind: 'pending',
				log,
				reason: `the covered slots are equal both ways, but the gap pin's proof is not verified yet: ${pin.detail}`,
			};
		case 'verified':
			break;
	}
	log.push(pin.line);
	const triple = (round: GapRound) => `${round.roundId} ${round.receiptHash} ${round.status}`;
	const pinned = new Map(pin.rounds.map((round) => [triple(round), 'the gap pin']));
	const gapListed = new Set(gapRounds.map(triple));
	const gapProblems = differences(
		pinned,
		gapListed,
		(key) => `the gap pin lists ${key}, which the indicative print of ${label} omits`,
		(key) => `the indicative print of ${label} lists ${key}, which the gap pin does not`,
	);
	if (gapProblems.length > 0) return { kind: 'mismatch', log, problems: gapProblems };
	log.push(
		`indicative ${label}: ${gapListed.size} gap receipts, equal both ways to the gap pin; all ${indicative.size + gapListed.size} receipts proved`,
	);
	return { kind: 'match', log };
}

/** Both ways: what `reference` lists that `listed` omits, then what `listed` adds. */
function differences(
	reference: ReadonlyMap<string, string>,
	listed: ReadonlySet<string>,
	omitted: (key: string, named: string) => string,
	added: (key: string) => string,
): string[] {
	return [
		...[...reference]
			.filter(([key]) => !listed.has(key))
			.map(([key, named]) => omitted(key, named)),
		...[...listed].filter((key) => !reference.has(key)).map(added),
	];
}

/**
 * The attest run's indicative check: each of `dates` that is an indicative day, proved in turn.
 * A MISMATCH fails it; PENDING, PARTIAL (E−1 with no gap pin yet) and could-not-verify (a day not
 * frozen yet, an unreachable API) are reported, never failed. Each PARTIAL is returned too, so the
 * run can write its gap pin. An error the proof did not expect fails that day only, and the rest
 * are still proved.
 */
export async function proveIndicativeDays(
	dates: readonly UtcDate[],
	baseUrl: string,
	checkout: BranchCheckout,
	get: Get,
	clock: () => Date,
): Promise<{
	lines: string[];
	failures: number;
	partial: Extract<IndicativeProof, { kind: 'partial' }>[];
}> {
	const lines: string[] = [];
	const partial: Extract<IndicativeProof, { kind: 'partial' }>[] = [];
	let failures = 0;
	for (const date of dates) {
		if (indicativeReleaseFor(date) === null) continue;
		let proof: IndicativeProof;
		try {
			proof = await proveIndicativeDay(date, baseUrl, checkout, get, clock);
		} catch (error) {
			failures += 1;
			lines.push(
				`${date}: FAILED: indicative proof error: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		lines.push(...proof.log);
		switch (proof.kind) {
			case 'match':
				lines.push(`${date}: indicative MATCH`);
				break;
			case 'pending':
				lines.push(`${date}: indicative PENDING: ${proof.reason}`);
				break;
			case 'partial':
				partial.push(proof);
				lines.push(
					`${date}: indicative PARTIAL: the covered slots are equal both ways; ${proof.unpinned.length} gap receipts are unpinned`,
				);
				break;
			case 'cannot_verify':
				lines.push(`${date}: indicative not checked: ${proof.reason}`);
				break;
			case 'mismatch':
				failures += 1;
				lines.push(`${date}: FAILED: indicative MISMATCH: ${proof.problems.join('; ')}`);
				break;
		}
	}
	return { lines, failures, partial };
}

/** Whether round `roundId`'s slot starts in `[start, end)`. */
function inInterval({ start, end }: Interval, roundId: string): boolean {
	const id = parseRoundId(roundId);
	return id !== null && id.slotStart >= start && id.slotStart < end;
}

type VerifiedReference = { kind: 'verified'; lines: string[]; named: string; pairs: Pair[] };

type Reference =
	| VerifiedReference
	| { kind: 'mismatch'; problems: string[] }
	| { kind: 'pending'; reason: string }
	| { kind: 'cannot_verify'; reason: string };

/**
 * The reference receipts of v1 day `date`: its latest revision that verifies on its own
 * (`proveRevisions`), once every served revision lists the same `(roundId, receiptHash)` set.
 * Every failure is an outcome, never an exception: a Mismatch from the API is a mismatch, and an
 * unreachable API, block explorer or checkout cannot be verified.
 */
async function verifiedReference(
	date: UtcDate,
	baseUrl: string,
	checkout: BranchCheckout,
	get: Get,
	clock: () => Date,
): Promise<Reference> {
	try {
		const publication = await fetchPublication(baseUrl, date, clock, get);
		if (publication.kind === 'not_yet_due') {
			return {
				kind: 'pending',
				reason: `v1 day ${date} is not settled yet (due by ${publication.publishBy})`,
			};
		}
		if (publication.kind === 'overdue') {
			return {
				kind: 'cannot_verify',
				reason: `v1 day ${date} is not settled, and its print was due by ${publication.publishBy}`,
			};
		}
		const day = await fetchSettledDay(baseUrl, date, get);
		const { problems, revisions } = await proveRevisions(day, checkout);
		if (problems.length > 0) return { kind: 'mismatch', problems };
		return referenceOf(date, day.revisions, revisions);
	} catch (error) {
		if (error instanceof Mismatch) return { kind: 'mismatch', problems: error.problems };
		if (error instanceof CannotVerify) return { kind: 'cannot_verify', reason: error.message };
		throw error;
	}
}

function referenceOf(
	date: UtcDate,
	served: readonly DailyPrint[],
	proofs: readonly RevisionProof[],
): Reference {
	const keysOf = (revision: DailyPrint) =>
		new Set(pairsOf(revision.rounds).map((pair) => pair.key));
	const [first, ...later] = served;
	if (first === undefined)
		return { kind: 'mismatch', problems: [`v1 day ${date} serves no revision`] };
	const firstKeys = keysOf(first);
	const disagreeing = later.filter((revision) => !sameSet(keysOf(revision), firstKeys));
	if (disagreeing.length > 0) {
		return {
			kind: 'mismatch',
			problems: disagreeing.map(
				(revision) =>
					`revisions of v1 day ${date} disagree: r${revision.revision} lists other receipts than r${first.revision}`,
			),
		};
	}
	const status = proofs.map((proof) => `r${proof.revision} ${describe(proof)}`);
	const verified = proofs.filter((proof) => proof.kind === 'proven').at(-1);
	if (verified === undefined) {
		return {
			kind: 'pending',
			reason: `v1 day ${date} has no verified revision yet (${status.join('; ')})`,
		};
	}
	const print = served.find((revision) => revision.revision === verified.revision);
	if (print === undefined) throw new Error(`r${verified.revision} of ${date} is not served`);
	const named = `v1 day ${date} r${print.revision}`;
	return {
		kind: 'verified',
		lines: [
			`reference ${named}: attested, Bitcoin block ${verified.height} at ${verified.time.toISOString()}, before its cutoff ${verified.cutoff.toISOString()}; ${firstKeys.size} receipts (${status.join('; ')})`,
		],
		named,
		pairs: pairsOf(print.rounds),
	};
}

function describe(proof: RevisionProof): string {
	switch (proof.kind) {
		case 'proven':
			return 'verified';
		case 'unattested':
			return `not attested (${proof.path})`;
		case 'pending':
		case 'invalid':
			return `not verified: ${proof.detail}`;
	}
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((item) => b.has(item));
}
