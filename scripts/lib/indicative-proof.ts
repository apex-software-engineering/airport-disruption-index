/**
 * The both-ways proof of an indicative ET day (design §4): the frozen print rebuilds from the
 * public API, and the set of `(roundId, receiptHash)` pairs it lists equals, exactly, the pairs the
 * verified v1 attestations of its UTC days list inside its window, invalid receipts included.
 * Nothing may be omitted and nothing added. A reference not yet verified makes the result PENDING,
 * never MATCH; verified revisions of one v1 day that disagree make it MISMATCH.
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
	fetchPublication,
	fetchSettledDay,
	reproduceIndicativeDay,
	type Get,
} from '@/lib/reproduce';

import { verifyAttestedDay, type BranchCheckout } from './attestations';
import { Pending, Unattested } from './public-api';

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
	const rebuilt = await reproduceIndicativeDay(label, baseUrl, get);
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
	const reference = new Map<string, string>();
	for (const date of references) {
		const verified = await verifiedReference(date, baseUrl, checkout, get, clock);
		if (verified.kind !== 'verified') return { ...verified, log };
		log.push(verified.line);
		for (const pair of verified.pairs) {
			if (inWindow(window, pair)) reference.set(pair.key, verified.named);
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

function inWindow(window: DayWindow, pair: Pair): boolean {
	const id = parseRoundId(pair.roundId);
	return id !== null && slotIndexIn(window, id.slotStart) !== null;
}

type Reference =
	| { kind: 'verified'; line: string; named: string; pairs: Pair[] }
	| { kind: 'mismatch'; problems: string[] }
	| { kind: 'pending'; reason: string }
	| { kind: 'cannot_verify'; reason: string };

/**
 * The receipts of v1 day `date`, once every revision of it is attested and its timestamp proven
 * (verify-attestation's MATCH). Receipts are final after admission, so every revision lists the
 * same `(roundId, receiptHash)` set, or the reference is a MISMATCH.
 */
async function verifiedReference(
	date: UtcDate,
	baseUrl: string,
	checkout: BranchCheckout,
	get: Get,
	clock: () => Date,
): Promise<Reference> {
	let publication;
	try {
		publication = await fetchPublication(baseUrl, date, clock, get);
	} catch (error) {
		if (error instanceof CannotVerify) return { kind: 'cannot_verify', reason: error.message };
		throw error;
	}
	if (publication.kind !== 'settled') {
		return {
			kind: 'pending',
			reason: `v1 day ${date} is not settled yet (due by ${publication.publishBy})`,
		};
	}
	const day = await fetchSettledDay(baseUrl, date, get);
	try {
		const problems = await verifyAttestedDay(day, checkout);
		if (problems.length > 0) return { kind: 'mismatch', problems };
	} catch (error) {
		if (error instanceof Pending || error instanceof Unattested) {
			return { kind: 'pending', reason: `v1 day ${date}: ${error.message}` };
		}
		throw error;
	}
	const keysOf = (revision: DailyPrint) =>
		new Set(pairsOf(revision.rounds).map((pair) => pair.key));
	const latest = keysOf(day.print);
	const disagreeing = day.revisions.filter((revision) => !sameSet(keysOf(revision), latest));
	if (disagreeing.length > 0) {
		return {
			kind: 'mismatch',
			problems: disagreeing.map(
				(revision) =>
					`verified revisions of v1 day ${date} disagree: r${revision.revision} lists other receipts than r${day.print.revision}`,
			),
		};
	}
	const named = `v1 day ${date} r${day.print.revision}`;
	return {
		kind: 'verified',
		line: `reference ${named}: attested and proven, ${latest.size} receipts`,
		named,
		pairs: pairsOf(day.print.rounds),
	};
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((item) => b.has(item));
}
