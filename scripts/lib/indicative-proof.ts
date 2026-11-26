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
 * (design §4, D8); until that lands it cannot be verified here.
 */
import { dayWindow, partitionsOf, slotIndexIn, type DayWindow } from '@/lib/index/calendar';
import { indicativeReleaseFor } from '@/lib/index/indicative';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import type { DailyPrint, RoundSummary } from '@/lib/index/schemas';
import { parseRoundId, type UtcDate } from '@/lib/index/time';
import {
	CannotVerify,
	Mismatch,
	fetchPublication,
	fetchSettledDay,
	reproduceIndicativeDay,
	type Get,
} from '@/lib/reproduce';

import { proveRevisions, type BranchCheckout, type RevisionProof } from './attestations';

export type IndicativeProof =
	| { kind: 'match'; log: string[] }
	| { kind: 'mismatch'; log: string[]; problems: string[] }
	/** The rebuild matches, but a v1 reference is not verified yet: no set comparison has run. */
	| { kind: 'pending'; log: string[]; reason: string }
	| { kind: 'cannot_verify'; log: string[]; reason: string };

/** A listed receipt as both sides are compared: its round and its hash. */
type Pair = { roundId: string; key: string };

function pairsOf(rounds: readonly Pick<RoundSummary, 'roundId' | 'receiptHash'>[]): Pair[] {
	return rounds.map(({ roundId, receiptHash }) => ({ roundId, key: `${roundId} ${receiptHash}` }));
}

/** Proves indicative ET day `label` against the attestations branch checked out at `checkout`. */
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
	const references = partitionsOf(window);
	const unowned = references.find(
		(date) => settlementReleaseOrNull(date)?.parameters.day !== 'utc',
	);
	if (unowned !== undefined) {
		return {
			kind: 'cannot_verify',
			log,
			reason: `${label}'s window reaches ${unowned}, which is no v1 UTC day: the E−1 branch and its gap pin are not part of this check yet`,
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
			if (inWindow(window, pair)) reference.set(pair.key, result.named);
		}
	}
	const indicative = new Set(pairsOf(rebuilt.print.rounds).map((pair) => pair.key));
	const problems = [
		...[...reference]
			.filter(([key]) => !indicative.has(key))
			.map(([key, named]) => `${named} lists ${key}, which the indicative print of ${label} omits`),
		...[...indicative]
			.filter((key) => !reference.has(key))
			.map(
				(key) =>
					`the indicative print of ${label} lists ${key}, which no verified v1 reference lists`,
			),
	];
	if (problems.length > 0) return { kind: 'mismatch', log, problems };
	log.push(
		`indicative ${label}: ${indicative.size} receipts, equal both ways to the verified v1 references (${references.join(', ')})`,
	);
	return { kind: 'match', log };
}

/**
 * The attest run's indicative check: each of `dates` that is an indicative day, proved in turn.
 * A MISMATCH fails it; PENDING and could-not-verify (a day not frozen yet, E−1 until its branch
 * lands, an unreachable API) are reported, never failed. An error the proof did not expect fails
 * that day only, and the rest are still proved.
 */
export async function proveIndicativeDays(
	dates: readonly UtcDate[],
	baseUrl: string,
	checkout: BranchCheckout,
	get: Get,
	clock: () => Date,
): Promise<{ lines: string[]; failures: number }> {
	const lines: string[] = [];
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
			case 'cannot_verify':
				lines.push(`${date}: indicative not checked: ${proof.reason}`);
				break;
			case 'mismatch':
				failures += 1;
				lines.push(`${date}: FAILED: indicative MISMATCH: ${proof.problems.join('; ')}`);
				break;
		}
	}
	return { lines, failures };
}

function inWindow(window: DayWindow, pair: Pair): boolean {
	const id = parseRoundId(pair.roundId);
	return id !== null && slotIndexIn(window, id.slotStart) !== null;
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
