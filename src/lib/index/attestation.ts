/**
 * Attestations pin a settled print outside the operator's storage. The print hash already covers
 * every receipt hash it lists; `roundsDigest` repeats that commitment in a form a verifier can
 * recompute from the receipt hashes alone.
 */
import type { OtsProof } from '@/lib/ots';

import { sha256Hex } from './json';
import { printHashMatches } from './print';
import type { Attestation, DailyPrint } from './schemas';
import { addDays, dayStartMs, type UtcDate } from './time';

export const ATTESTATION_SCHEMA = 'adi.attestation/1' as const;

/** sha256 over the print's receipt hashes, in the order the print lists them, joined by '\n'. */
export function roundsDigest(print: DailyPrint): string {
	return sha256Hex(print.rounds.map((round) => round.receiptHash).join('\n'));
}

/**
 * The exact bytes an attestation file holds. Frozen: the proofs commit to these bytes, so any
 * change to field order or formatting would make every future file differ from the past ones.
 */
export function serializeAttestation(attestation: Attestation): string {
	return `${JSON.stringify(attestation, null, '\t')}\n`;
}

export function buildAttestation(print: DailyPrint, deployedCommit: string | null): Attestation {
	return {
		schema: ATTESTATION_SCHEMA,
		date: print.date,
		revision: print.revision,
		printHash: print.printHash,
		roundsDigest: roundsDigest(print),
		parameterHash: print.parameterHash,
		methodologyVersion: print.methodologyVersion,
		deployedCommit,
	};
}

/**
 * Checks a published print against the attestation for its date and revision. Returns the
 * problems found; an empty list is a match. `deployedCommit` is not compared: it records the
 * deployment at attestation time, and later deploys change it.
 */
export function attestationProblems(attestation: Attestation, print: DailyPrint): string[] {
	const problems: string[] = [];
	if (!printHashMatches(print)) problems.push('printHash does not match the print contents');
	const expected = buildAttestation(print, attestation.deployedCommit);
	for (const field of [
		'date',
		'revision',
		'printHash',
		'roundsDigest',
		'parameterHash',
		'methodologyVersion',
	] as const) {
		if (expected[field] !== attestation[field]) {
			problems.push(
				`${field}: print has ${expected[field]}, attestation has ${attestation[field]}`,
			);
		}
	}
	return problems;
}

/** A correction's attestation must be stamped within this many hours of its `issuedAt`. */
export const CORRECTION_STAMP_HOURS = 48;

/**
 * The time by which a print's attestation must be timestamped. Revision 1 of day D: D+2 00:00Z.
 * A correction: CORRECTION_STAMP_HOURS after the print's `issuedAt` (an ISO instant the
 * correction process, #10, records on revisions after 1); null while a correction lacks it,
 * since its cutoff cannot be checked then. The calendars keep the first commitment, so a rewritten
 * attestation needs a new, later timestamp, and the cutoff exposes it.
 */
export function publicationCutoff(print: {
	date: UtcDate;
	revision: number;
	issuedAt?: string;
}): Date | null {
	if (print.revision === 1) return new Date(dayStartMs(addDays(print.date, 2)));
	if (print.issuedAt === undefined) return null;
	const issued = Date.parse(print.issuedAt);
	if (Number.isNaN(issued)) throw new Error(`issuedAt ${print.issuedAt} is not an instant`);
	return new Date(issued + CORRECTION_STAMP_HOURS * 3_600_000);
}

/**
 * Checks every attestation pinned for a date against the API's revisions of that day: each pinned
 * revision must still be served (no rollback) and must match its print (no conflict).
 */
export function pinProblems(
	pins: readonly Attestation[],
	revisions: readonly DailyPrint[],
): string[] {
	return pins.flatMap((pin) => {
		const print = revisions.find((r) => r.revision === pin.revision);
		if (print === undefined)
			return [`revision ${pin.revision} is attested but the API no longer serves it`];
		return attestationProblems(pin, print).map((problem) => `r${pin.revision}: ${problem}`);
	});
}

/** A Bitcoin block as a block explorer reports it. */
export type BitcoinBlock = { merkleRoot: string; time: Date };

export type TimestampVerdict =
	| { kind: 'proven'; height: number; time: Date; cutoff: Date }
	| { kind: 'pending'; calendars: string[] }
	| { kind: 'invalid'; problem: string };

/**
 * What a proof shows about when the attestation file existed. Uses the earliest Bitcoin block
 * the proof reaches, and that block's header time, which its miner sets (consensus keeps it
 * within about two hours of real time). A proof with no block is pending: its time cannot be
 * proven yet.
 */
export async function checkTimestamp(
	cutoff: Date,
	file: Uint8Array,
	proof: OtsProof,
	blockAt: (height: number) => Promise<BitcoinBlock>,
): Promise<TimestampVerdict> {
	if (proof.fileSha256 !== sha256Hex(file))
		return { kind: 'invalid', problem: 'the proof does not commit to this attestation file' };
	const [earliest] = proof.attestations
		.flatMap((a) => (a.kind === 'bitcoin' ? [a] : []))
		.sort((a, b) => a.height - b.height);
	if (earliest === undefined) {
		const calendars = proof.attestations.flatMap((a) =>
			a.kind === 'pending' ? [a.calendarUrl] : [],
		);
		return { kind: 'pending', calendars };
	}
	const block = await blockAt(earliest.height);
	if (block.merkleRoot !== earliest.merkleRoot) {
		return {
			kind: 'invalid',
			problem: `Bitcoin block ${earliest.height} has merkle root ${block.merkleRoot}, the proof needs ${earliest.merkleRoot}`,
		};
	}
	if (block.time >= cutoff) {
		return {
			kind: 'invalid',
			problem: `timestamped by Bitcoin block ${earliest.height} at ${block.time.toISOString()}, after the publication cutoff ${cutoff.toISOString()}`,
		};
	}
	return { kind: 'proven', height: earliest.height, time: block.time, cutoff };
}
