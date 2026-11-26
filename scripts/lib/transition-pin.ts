/**
 * The gap pin (design §4, D8): `transition/{effectiveFrom}.json` on the attestations branch, the
 * one external pin of the receipts in an activated cutover's transition interval, which no
 * settlement print covers. Its path and window are derived from the registry's activated cutover,
 * never from a constant, so a postponed cutover moves them with it. It is written once by the
 * attest run, after the interval has ended and the last indicative day has frozen, and stamped
 * like an attestation: write-once, proof committed beside it, cutoff = interval end + 24 h.
 * verify-attestation never reads `transition/`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Cutover, Interval } from '@/lib/index/calendar';
import { roundIdSchema } from '@/lib/index/schemas';

import { firstCommittedFiles, proveFile, type BranchCheckout } from './attestations';

export const TRANSITION_PIN_SCHEMA = 'adi.transition-pin/1' as const;

/** How long after the transition interval ends its pin must be timestamped. */
const PIN_STAMP_HOURS = 24;

/** A receipt in the interval, as the last indicative print lists it. */
export type GapRound = { roundId: string; receiptHash: string; status: 'valid' | 'invalid' };

const pinSchema = z.strictObject({
	schema: z.literal(TRANSITION_PIN_SCHEMA),
	window: z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() }),
	rounds: z.array(
		z.strictObject({
			roundId: roundIdSchema,
			receiptHash: z.string().regex(/^[0-9a-f]{64}$/),
			status: z.enum(['valid', 'invalid']),
		}),
	),
});

/**
 * The transition interval of a cutover: from the end of the old release's last day to the start
 * of the new one's first.
 */
export function gapOf(cutover: Cutover): Interval {
	return { start: cutover.previous.end, end: cutover.next.start };
}

/** The pin's path on the branch, relative to its root. */
export function transitionPinName(cutover: Cutover): string {
	return `transition/${cutover.to.effectiveFrom}.json`;
}

/** The pin's proof must reach a Bitcoin block before this instant. */
export function transitionPinCutoff(cutover: Cutover): Date {
	return new Date(gapOf(cutover).end.getTime() + PIN_STAMP_HOURS * 3_600_000);
}

/** The exact bytes of a pin, as attestation files are written: tab-indented JSON and a newline. */
export function serializeTransitionPin(cutover: Cutover, rounds: readonly GapRound[]): string {
	const { start, end } = gapOf(cutover);
	const pin: z.infer<typeof pinSchema> = {
		schema: TRANSITION_PIN_SCHEMA,
		window: { start: start.toISOString(), end: end.toISOString() },
		rounds: [...rounds]
			.sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0))
			.map(({ roundId, receiptHash, status }) => ({ roundId, receiptHash, status })),
	};
	return `${JSON.stringify(pin, null, '\t')}\n`;
}

/**
 * Writes the pin, once: refused before the interval has ended, at or after its cutoff (no proof
 * could then be timely, so none is manufactured), and if the file already exists.
 */
export async function writeTransitionPin(
	directory: string,
	cutover: Cutover,
	rounds: readonly GapRound[],
	now: Date,
): Promise<string> {
	const gap = gapOf(cutover);
	if (now < gap.end) {
		throw new Error(`the transition interval runs until ${gap.end.toISOString()}; no pin yet`);
	}
	const cutoff = transitionPinCutoff(cutover);
	if (now >= cutoff) {
		throw new Error(
			`the pin's cutoff ${cutoff.toISOString()} has passed; a pin written now could not be timely`,
		);
	}
	const file = path.join(directory, transitionPinName(cutover));
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, serializeTransitionPin(cutover, rounds), { flag: 'wx' });
	return file;
}

/** What the branch shows about a cutover's pin. */
export type TransitionPin =
	| { kind: 'absent'; name: string }
	/** Rewritten, deleted, unreadable, for another window, or its proof invalid or late. */
	| { kind: 'mismatch'; problems: string[] }
	/** As first committed and for the derived window, but its proof has no block yet. */
	| { kind: 'pending'; detail: string }
	| { kind: 'verified'; rounds: GapRound[]; line: string };

/** Reads the cutover's pin as first committed to the branch, and checks it and its proof. */
export async function readTransitionPin(
	checkout: BranchCheckout,
	cutover: Cutover,
): Promise<TransitionPin> {
	const name = transitionPinName(cutover);
	const { files, problems } = firstCommittedFiles(checkout, name, (file) => file === name);
	if (problems.length > 0) return { kind: 'mismatch', problems };
	const bytes = files.get(name);
	if (bytes === undefined) return { kind: 'absent', name };
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { kind: 'mismatch', problems: [`${name} is not JSON`] };
	}
	const pin = pinSchema.safeParse(body);
	if (!pin.success) {
		return {
			kind: 'mismatch',
			problems: [`${name} fails its schema: ${z.prettifyError(pin.error)}`],
		};
	}
	const gap = gapOf(cutover);
	const { start, end } = pin.data.window;
	if (start !== gap.start.toISOString() || end !== gap.end.toISOString()) {
		return {
			kind: 'mismatch',
			problems: [
				`${name} pins [${start}, ${end}), not the transition interval [${gap.start.toISOString()}, ${gap.end.toISOString()})`,
			],
		};
	}
	const proof = await proveFile(
		`${checkout.directory}/${name}.ots`,
		bytes,
		transitionPinCutoff(cutover),
	);
	if (proof.kind === 'invalid') return { kind: 'mismatch', problems: [proof.detail] };
	if (proof.kind === 'pending') return { kind: 'pending', detail: proof.detail };
	return {
		kind: 'verified',
		rounds: pin.data.rounds,
		line: `gap pin ${name}: ${pin.data.rounds.length} receipts, Bitcoin block ${proof.height} at ${proof.time.toISOString()}, before its cutoff ${proof.cutoff.toISOString()}`,
	};
}
