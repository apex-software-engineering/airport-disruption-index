/**
 * The gap pin (design §4, D8): `transition/{effectiveFrom}.json` on the attestations branch, the
 * one external pin of the receipts in an activated cutover's transition interval, which no
 * settlement print covers. Its path, window and cutoff are derived from the registry's activated
 * cutover, never from a constant, so a postponed cutover moves them with it.
 *
 * Its receipts are read slot by slot from the public archive (`/api/v1/rounds/{id}`), not copied
 * from the indicative print: the gap has no v1 reference, so the archive is the only independent
 * side, and a print that omitted a stored gap receipt would otherwise pin its own omission.
 *
 * It is written once by the attest run, between E−1's freeze time and 12 hours before its cutoff
 * (interval end + 24 h), and stamped like an attestation: write-once, proof committed beside it.
 * verify-attestation never reads `transition/`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { Cutover, Interval } from '@/lib/index/calendar';
import { indicativeFreezesAt } from '@/lib/index/indicative';
import { identityOf, type Identity } from '@/lib/index/methodology';
import { receiptHashMatches } from '@/lib/index/round';
import { receiptShapeSchema, roundIdSchema } from '@/lib/index/schemas';
import { addDays, roundIdFor } from '@/lib/index/time';
import { CannotVerify, Mismatch, type Get } from '@/lib/reproduce';

import { firstCommittedFiles, proveFile, type BranchCheckout } from './attestations';

export const TRANSITION_PIN_SCHEMA = 'adi.transition-pin/1' as const;

const HOUR_MS = 3_600_000;
/** How long after the transition interval ends its pin must be timestamped. */
const PIN_STAMP_HOURS = 24;
/**
 * No pin is written in the last hours before its cutoff: a calendar takes hours to reach a block,
 * so a pin written then would almost surely be late, and fail every run while E−1 is checked.
 */
const PIN_WRITE_MARGIN_HOURS = 12;
/**
 * How far a block's header time may run behind real time (consensus keeps it within about two
 * hours). A proof dated earlier than this before the interval ended predates its own receipts.
 */
const BLOCK_TIME_SLACK_HOURS = 2;

/** A receipt in the interval: its round, its hash, and whether its observation was valid. */
export type GapRound = { roundId: string; receiptHash: string; status: 'valid' | 'invalid' };

const identitySchema = z.strictObject({
	methodologyVersion: z.string(),
	parameterHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const pinSchema = z.strictObject({
	schema: z.literal(TRANSITION_PIN_SCHEMA),
	/** The release that took effect at the interval's start, which collected its rounds. */
	release: identitySchema,
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

/** The last indicative day of the cutover, E−1, whose window ends in the interval. */
export function lastIndicativeDay(cutover: Cutover): string {
	return addDays(cutover.to.effectiveFrom, -1);
}

/** The pin's path on the branch, relative to its root. */
export function transitionPinName(cutover: Cutover): string {
	return `transition/${cutover.to.effectiveFrom}.json`;
}

/** The pin's proof must reach a Bitcoin block before this instant. */
export function transitionPinCutoff(cutover: Cutover): Date {
	return new Date(gapOf(cutover).end.getTime() + PIN_STAMP_HOURS * HOUR_MS);
}

/**
 * When the pin may be written: from E−1's freeze time (the interval has ended and the print is
 * final) until 12 hours before the pin's cutoff.
 */
export function pinWritable(cutover: Cutover): Interval {
	return {
		start: indicativeFreezesAt(cutover.to, lastIndicativeDay(cutover)),
		end: new Date(transitionPinCutoff(cutover).getTime() - PIN_WRITE_MARGIN_HOURS * HOUR_MS),
	};
}

const byRoundId = (a: GapRound, b: GapRound) =>
	a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0;

/** The exact bytes of a pin, as attestation files are written: tab-indented JSON and a newline. */
export function serializeTransitionPin(cutover: Cutover, rounds: readonly GapRound[]): string {
	const { start, end } = gapOf(cutover);
	const pin: z.infer<typeof pinSchema> = {
		schema: TRANSITION_PIN_SCHEMA,
		release: identityOf(cutover.to),
		window: { start: start.toISOString(), end: end.toISOString() },
		rounds: [...rounds]
			.sort(byRoundId)
			.map(({ roundId, receiptHash, status }) => ({ roundId, receiptHash, status })),
	};
	return `${JSON.stringify(pin, null, '\t')}\n`;
}

/** Writes the pin, once, and only while it is writable (`pinWritable`). */
export async function writeTransitionPin(
	directory: string,
	cutover: Cutover,
	rounds: readonly GapRound[],
	now: Date,
): Promise<string> {
	const writable = pinWritable(cutover);
	if (now < writable.start) {
		throw new Error(`the gap pin may be written from ${writable.start.toISOString()}`);
	}
	if (now >= writable.end) {
		throw new Error(
			`no gap pin is written in the 12 hours before its cutoff ${transitionPinCutoff(cutover).toISOString()}: one written now would almost surely be late`,
		);
	}
	const file = path.join(directory, transitionPinName(cutover));
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, serializeTransitionPin(cutover, rounds), { flag: 'wx' });
	return file;
}

/** The pin's bytes as first committed to the branch, null if never committed, or its problems. */
export function committedPin(
	checkout: BranchCheckout,
	cutover: Cutover,
): { bytes: Uint8Array | null; problems: string[] } {
	const name = transitionPinName(cutover);
	const { files, problems } = firstCommittedFiles(checkout, name, (file) => file === name);
	return { bytes: files.get(name) ?? null, problems };
}

/** What the branch shows about a cutover's pin. */
export type TransitionPin =
	| { kind: 'absent'; name: string }
	/** Rewritten, deleted, unreadable, for another window or release, or its proof invalid or late. */
	| { kind: 'mismatch'; problems: string[] }
	/** As first committed and for the derived window, but its proof has no block yet. */
	| { kind: 'pending'; detail: string }
	/** A block explorer could not answer for its proof. */
	| { kind: 'cannot_verify'; reason: string }
	| { kind: 'verified'; rounds: GapRound[]; line: string };

/** Reads the cutover's pin as first committed to the branch, and checks it and its proof. */
export async function readTransitionPin(
	checkout: BranchCheckout,
	cutover: Cutover,
): Promise<TransitionPin> {
	const name = transitionPinName(cutover);
	const { bytes, problems } = committedPin(checkout, cutover);
	if (problems.length > 0) return { kind: 'mismatch', problems };
	if (bytes === null) return { kind: 'absent', name };
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
	if (!sameIdentity(pin.data.release, identityOf(cutover.to))) {
		return {
			kind: 'mismatch',
			problems: [`${name} names release ${pin.data.release.methodologyVersion}, not the cutover's`],
		};
	}
	let proof;
	try {
		proof = await proveFile(
			`${checkout.directory}/${name}.ots`,
			bytes,
			transitionPinCutoff(cutover),
		);
	} catch (error) {
		if (error instanceof CannotVerify) return { kind: 'cannot_verify', reason: error.message };
		throw error;
	}
	if (proof.kind === 'invalid') return { kind: 'mismatch', problems: [proof.detail] };
	if (proof.kind === 'pending') return { kind: 'pending', detail: proof.detail };
	const earliest = new Date(gap.end.getTime() - BLOCK_TIME_SLACK_HOURS * HOUR_MS);
	if (proof.time < earliest) {
		return {
			kind: 'mismatch',
			problems: [
				`${name} is timestamped by Bitcoin block ${proof.height} at ${proof.time.toISOString()}, before the receipts it pins could exist (the interval ends ${gap.end.toISOString()})`,
			],
		};
	}
	return {
		kind: 'verified',
		rounds: pin.data.rounds,
		line: `gap pin ${name}: ${pin.data.rounds.length} receipts, Bitcoin block ${proof.height} at ${proof.time.toISOString()}, before its cutoff ${proof.cutoff.toISOString()}`,
	};
}

function sameIdentity(a: Identity, b: Identity): boolean {
	return a.methodologyVersion === b.methodologyVersion && a.parameterHash === b.parameterHash;
}

const servedSchema = z.object({ version: z.string(), parameterHash: z.string() });

/**
 * Checks the deployment at `baseUrl` is collecting under the cutover's new release, so step 2 is
 * live there and not only in this checkout: a step-1 deployment still collects v1 rounds in the
 * would-be gap, and must never have them pinned as the transition.
 */
export async function requireServedCutover(
	baseUrl: string,
	cutover: Cutover,
	get: Get,
): Promise<void> {
	const url = `${baseUrl}/api/v1/methodology`;
	const response = await get(url).catch((error: unknown) => {
		throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
	});
	if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
	const served = servedSchema.safeParse(await response.json().catch(() => null));
	if (!served.success) throw new CannotVerify(`${url} answered unreadably`);
	const expected = identityOf(cutover.to);
	if (
		!sameIdentity(
			{ methodologyVersion: served.data.version, parameterHash: served.data.parameterHash },
			expected,
		)
	) {
		throw new Mismatch([
			`${url} collects under ${served.data.version} (${served.data.parameterHash}), not ${expected.methodologyVersion}: the cutover is not live there`,
		]);
	}
}

/**
 * Every receipt the public archive holds in the interval, one request per slot: 200 is a receipt
 * this code can verify; 404 an empty slot; 422 a receipt recording a release this code does not
 * know (foreign), read from E−1's evidence endpoint, which serves it only if E−1 lists it, so a
 * 404 there is a stored receipt the print omits. Anything else cannot be verified.
 */
export async function readGapReceipts(
	cutover: Cutover,
	baseUrl: string,
	get: Get,
): Promise<GapRound[]> {
	const gap = gapOf(cutover);
	const label = lastIndicativeDay(cutover);
	const ids: string[] = [];
	for (let at = gap.start.getTime(); at < gap.end.getTime(); at += 5 * 60_000)
		ids.push(roundIdFor(new Date(at)));
	const read = async (path: string) => {
		const url = `${baseUrl}${path}`;
		const response = await get(url).catch((error: unknown) => {
			throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
		});
		return { url, response };
	};
	const rounds: GapRound[] = [];
	for (const id of ids) {
		let { url, response } = await read(`/api/v1/rounds/${id}`);
		if (response.status === 404) continue;
		if (response.status === 422) {
			({ url, response } = await read(`/api/v1/indicative/days/${label}/rounds/${id}`));
			if (response.status === 404) {
				throw new Mismatch([
					`the archive holds a receipt for ${id} that the indicative print of ${label} does not list`,
				]);
			}
		}
		if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
		const receipt = receiptShapeSchema.safeParse(await response.json().catch(() => null));
		if (!receipt.success || receipt.data.roundId !== id || !receiptHashMatches(receipt.data)) {
			throw new Mismatch([`${url} serves round ${id} malformed or with a wrong receiptHash`]);
		}
		rounds.push({
			roundId: id,
			receiptHash: receipt.data.receiptHash,
			status: receipt.data.observation.status,
		});
	}
	return rounds;
}

/** `(roundId, receiptHash, status)`, the key both sides of a gap comparison use. */
export function gapKey(round: GapRound): string {
	return `${round.roundId} ${round.receiptHash} ${round.status}`;
}

/** Both ways: what `reference` holds that `listed` omits, then what `listed` adds. */
export function gapDifferences(
	reference: readonly GapRound[],
	listed: readonly GapRound[],
	omitted: (key: string) => string,
	added: (key: string) => string,
): string[] {
	const referenceKeys = new Set(reference.map(gapKey));
	const listedKeys = new Set(listed.map(gapKey));
	return [
		...[...referenceKeys].filter((key) => !listedKeys.has(key)).map(omitted),
		...[...listedKeys].filter((key) => !referenceKeys.has(key)).map(added),
	];
}
