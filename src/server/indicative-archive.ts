/**
 * The indicative series' storage (design §4): frozen indicative prints under
 * `indicative/{version}/{date}.json`, and the receipts they list, read as evidence for those
 * prints only. Never a settlement read; settlement storage is archive.ts.
 */

import { dayWindow, type DayWindow } from '@/lib/index/calendar';
import {
	type IndicativeAdmission,
	indicativeAdmissionFor,
	indicativeFreezesAt,
	indicativeReleaseFor,
} from '@/lib/index/indicative';
import { admits, isUnder, methodologyOf } from '@/lib/index/methodology';
import { buildIndicativePrint } from '@/lib/index/print';
import { receiptHashMatches, summarizeReceipt } from '@/lib/index/round';
import {
	indicativePrintSchema,
	receiptSchema,
	receiptShapeSchema,
	type IndicativePrint,
	type RoundReceipt,
	type RoundSummary,
} from '@/lib/index/schemas';
import type { RoundId } from '@/lib/index/time';
import { verifyRound } from '@/lib/index/verify';

import {
	dateOf,
	encode,
	JSON_TYPE,
	keys,
	listWindowReceipts,
	MAX_CONDITIONAL_ATTEMPTS,
	readInBatches,
	readRaw,
} from './archive';
import type { ObjectStore, StoredObject } from './storage';

/** A round asked for as evidence for an indicative print. */
export type IndicativeRound =
	| { kind: 'receipt'; receipt: RoundReceipt }
	/** The day is not frozen, or its print does not list the round. */
	| { kind: 'not_listed' }
	/** Listed, but its stored receipt is missing, unreadable or not the one listed: never served. */
	| { kind: 'unservable'; reason: string };

/**
 * A round a frozen indicative print lists, as evidence for that print only, served only with the
 * hash the print lists. A receipt from a release this code does not know is returned by its shape
 * (it was foreign in the print). Stored content that cannot be served is classified, never thrown.
 */
export async function readIndicativeRound(
	store: ObjectStore,
	label: string,
	id: RoundId,
): Promise<IndicativeRound> {
	const day = await readIndicativeDay(store, label);
	const listed = day.kind === 'frozen' ? day.print.rounds.find((r) => r.roundId === id) : undefined;
	if (listed === undefined) return { kind: 'not_listed' };
	const key = keys.receipt(dateOf(id), id);
	const object = await store.read(key);
	const receipt = object === null ? null : decodeReceipt(object);
	if (receipt === null) {
		return {
			kind: 'unservable',
			reason: `${key}, listed by the indicative print of ${label}, is not a readable receipt`,
		};
	}
	if (receipt.receiptHash !== listed.receiptHash || !receiptHashMatches(receipt)) {
		return {
			kind: 'unservable',
			reason: `${key} is not the receipt the indicative print of ${label} lists`,
		};
	}
	return { kind: 'receipt', receipt };
}

/**
 * A stored receipt, for the indicative series only. One that records a release this code does not
 * know cannot pass `receiptSchema`; it is returned by its shape alone, once its hash matches, so
 * it can be listed and served as a foreign round. It never counts: no day admits a release this
 * code does not know.
 */
function decodeReceipt(object: StoredObject): RoundReceipt | null {
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(object.body));
	} catch {
		return null;
	}
	const full = receiptSchema.safeParse(body);
	if (full.success) return full.data;
	const shape = receiptShapeSchema.safeParse(body);
	const unknown =
		shape.success &&
		methodologyOf(shape.data.methodologyVersion, shape.data.parameterHash) === null &&
		receiptHashMatches(shape.data);
	return unknown ? shape.data : null;
}

export type FreezeOutcome = { status: 'frozen' | 'already_frozen'; print: IndicativePrint };

/**
 * Builds and stores the indicative print of ET day `label` (design §4), once its admission has
 * closed and admitted writes have drained: at or after the day's end plus the settlement cutoff.
 * Written once and never revised; a second run returns the stored print.
 */
export async function freezeIndicativeDay(
	store: ObjectStore,
	label: string,
	now: Date,
): Promise<FreezeOutcome> {
	const release = indicativeReleaseFor(label);
	const admission = release === null ? null : indicativeAdmissionFor(release);
	if (release === null || admission === null) throw new Error(`${label} has no indicative day`);
	const window = dayWindow(release, label);
	const freezesAt = indicativeFreezesAt(release, label);
	if (now < freezesAt) {
		throw new Error(`${label} (ET, indicative) freezes at ${freezesAt.toISOString()}`);
	}
	const key = keys.indicative(release.parameters.version, label);
	const stored = await readIndicativeDay(store, label);
	// Its key holds something else: never overwritten, and nothing is frozen over it.
	if (stored.kind === 'misfiled') throw new Error(stored.reason);
	if (stored.kind === 'frozen') return { status: 'already_frozen', print: stored.print };
	const rounds = await readIndicativeRounds(store, window, admission);
	const print = buildIndicativePrint({ release, window }, rounds, admission);
	if ((await store.write(key, encode(print), JSON_TYPE, { kind: 'if-absent' })) === 'written') {
		return { status: 'frozen', print };
	}
	// Another run froze it first. Its print may not be readable yet; give it a few reads.
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const winner = await readIndicativeDay(store, label);
		if (winner.kind === 'misfiled') throw new Error(winner.reason);
		if (winner.kind === 'frozen') return { status: 'already_frozen', print: winner.print };
	}
	throw new Error(`indicative print ${label} exists but could not be read`);
}

/** What is stored at an indicative key: its day's print, or misfiled (never served). */
type IndicativeObject =
	{ kind: 'print'; print: IndicativePrint } | { kind: 'misfiled'; reason: string };

/**
 * The one classifier of stored indicative objects, used by every reader of them (day, history,
 * freeze, round evidence). It never throws on stored content: the object at `key` must be the
 * indicative print that key names, under the release that computes its day.
 */
function classifyIndicativeObject(key: string, bytes: Uint8Array): IndicativeObject {
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { kind: 'misfiled', reason: `${key} is not JSON` };
	}
	const parsed = indicativePrintSchema.safeParse(body);
	if (!parsed.success) return { kind: 'misfiled', reason: `${key} is not an indicative print` };
	const print = parsed.data;
	const release = indicativeReleaseFor(print.date, { includeWithdrawn: true });
	if (
		key !== keys.indicative(print.methodologyVersion, print.date) ||
		release === null ||
		!isUnder(release, print)
	) {
		return {
			kind: 'misfiled',
			reason: `${key} holds the indicative print of ${print.date} under ${print.methodologyVersion}`,
		};
	}
	return { kind: 'print', print };
}

/** An indicative day as stored: frozen, not frozen (or no such day), or its key holds something else. */
export type IndicativeDay =
	| { kind: 'frozen'; print: IndicativePrint }
	| { kind: 'none' }
	| { kind: 'misfiled'; key: string; reason: string };

/** The stored indicative print of ET day `label`, classified. */
export async function readIndicativeDay(store: ObjectStore, label: string): Promise<IndicativeDay> {
	const release = indicativeReleaseFor(label, { includeWithdrawn: true });
	if (release === null) return { kind: 'none' };
	const key = keys.indicative(release.parameters.version, label);
	const object = await store.read(key);
	if (object === null) return { kind: 'none' };
	const classified = classifyIndicativeObject(key, object.body);
	return classified.kind === 'print'
		? { kind: 'frozen', print: classified.print }
		: { kind: 'misfiled', key, reason: classified.reason };
}

/** The indicative print of ET day `label`, or null when it is not frozen or its key is misfiled. */
export async function readIndicativePrint(
	store: ObjectStore,
	label: string,
): Promise<IndicativePrint | null> {
	const day = await readIndicativeDay(store, label);
	return day.kind === 'frozen' ? day.print : null;
}

/**
 * The rounds of an indicative day's window, read across its UTC partitions with ids filtered to
 * the window first. A receipt recording an identity the admission policy does not accept, known
 * to this code or not, is kept as a foreign round: it takes no slot and suspends the day. An
 * admitted receipt counts only after it rebuilds, from its archived body, under the release and
 * adapter it records, so a receipt claiming a valid observation it cannot back never counts.
 * Anything unreadable, failing its hash, or not rebuilding stops the run.
 */
async function readIndicativeRounds(
	store: ObjectStore,
	window: DayWindow,
	admission: IndicativeAdmission,
): Promise<RoundSummary[]> {
	return readInBatches(await listWindowReceipts(store, window), async ({ partition, id }) => {
		const key = keys.receipt(partition, id);
		const object = await store.read(key);
		if (object === null) throw new Error(`receipt ${key} is listed but could not be read`);
		const receipt = decodeReceipt(object);
		// Freezing stops on any receipt it cannot read: a frozen print never omits one (design §4).
		if (receipt === null) throw new Error(`stored object ${key} is not a receipt`);
		if (receipt.roundId !== id) throw new Error(`${key} holds round ${receipt.roundId}`);
		if (!receiptHashMatches(receipt))
			throw new Error(`receipt ${key} does not match its receiptHash`);
		if (!admits(admission.accepts, receipt)) return summarizeReceipt(receipt);
		const problems = verifyRound(receipt, await readRaw(store, receipt));
		if (problems.length > 0)
			throw new Error(`receipt ${key} does not rebuild: ${problems.join('; ')}`);
		return summarizeReceipt(receipt);
	});
}

const INDICATIVE_KEY = /^indicative\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/;

/** Stored indicative objects no reader serves, under their own problem code. */
export type MisfiledIndicative = { problem: 'misfiled_indicative'; objects: string[] };

/**
 * Every frozen indicative print with a date in [from, to], oldest first, and the listed keys in
 * that range that hold something else (never served, reported).
 */
export async function readIndicativePrints(
	store: ObjectStore,
	from: string,
	to: string,
): Promise<{ prints: IndicativePrint[]; misfiled: MisfiledIndicative | null }> {
	const listed = (await store.list(keys.indicativeRoot())).filter((key) => {
		const date = INDICATIVE_KEY.exec(key)?.[2];
		return date !== undefined && date >= from && date <= to;
	});
	const read = await readInBatches(listed, async (key) => {
		const object = await store.read(key);
		return { key, classified: object === null ? null : classifyIndicativeObject(key, object.body) };
	});
	const prints: IndicativePrint[] = [];
	const misfiled: string[] = [];
	for (const { key, classified } of read) {
		// A listed key that is not its day's print, or cannot be read at all, is reported: never
		// silently left out of the series.
		if (classified?.kind === 'print') prints.push(classified.print);
		else misfiled.push(key);
	}
	return {
		prints: prints.sort((x, y) => x.date.localeCompare(y.date)),
		misfiled: misfiled.length === 0 ? null : { problem: 'misfiled_indicative', objects: misfiled },
	};
}
