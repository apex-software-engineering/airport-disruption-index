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
import { admits, isUnder, methodologyOf, type Methodology } from '@/lib/index/methodology';
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
	readJson,
	readRaw,
} from './archive';
import type { ObjectStore, StoredObject } from './storage';

/**
 * A round a frozen indicative print lists, as evidence for that print only: null unless the day
 * is frozen and lists `id`, and refused unless its hash is the one the print lists. A receipt from
 * a release this code does not know is returned by its shape (it was foreign in the print).
 */
export async function readIndicativeRound(
	store: ObjectStore,
	label: string,
	id: RoundId,
): Promise<RoundReceipt | null> {
	const listed = (await readIndicativePrint(store, label))?.rounds.find((r) => r.roundId === id);
	if (listed === undefined) return null;
	const key = keys.receipt(dateOf(id), id);
	const object = await store.read(key);
	if (object === null)
		throw new Error(`${key} is listed by the indicative print of ${label} but missing`);
	const receipt = decodeReceipt(key, object);
	if (receipt.receiptHash !== listed.receiptHash || !receiptHashMatches(receipt)) {
		throw new Error(`${key} is not the receipt the indicative print of ${label} lists`);
	}
	return receipt;
}

/**
 * A stored receipt, for the indicative series only. One that records a release this code does not
 * know cannot pass `receiptSchema`; it is returned by its shape alone, once its hash matches, so
 * it can be listed and served as a foreign round. It never counts: no day admits a release this
 * code does not know.
 */
function decodeReceipt(key: string, object: StoredObject): RoundReceipt {
	const body: unknown = JSON.parse(new TextDecoder().decode(object.body));
	const full = receiptSchema.safeParse(body);
	if (full.success) return full.data;
	const shape = receiptShapeSchema.safeParse(body);
	const unknown =
		shape.success &&
		methodologyOf(shape.data.methodologyVersion, shape.data.parameterHash) === null &&
		receiptHashMatches(shape.data);
	if (unknown) return shape.data;
	throw new Error(`stored object ${key} fails its schema: ${full.error.message}`);
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
	const stored = await readIndicativeAt(store, key, release, label);
	if (stored !== null) return { status: 'already_frozen', print: stored };
	const rounds = await readIndicativeRounds(store, window, admission);
	const print = buildIndicativePrint({ release, window }, rounds, admission);
	if ((await store.write(key, encode(print), JSON_TYPE, { kind: 'if-absent' })) === 'written') {
		return { status: 'frozen', print };
	}
	// Another run froze it first. Its print may not be readable yet; give it a few reads.
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const winner = await readIndicativeAt(store, key, release, label);
		if (winner !== null) return { status: 'already_frozen', print: winner };
	}
	throw new Error(`indicative print ${label} exists but could not be read`);
}

/** The indicative print of ET day `label`, or null when it has none or it is not frozen yet. */
export async function readIndicativePrint(
	store: ObjectStore,
	label: string,
): Promise<IndicativePrint | null> {
	const release = indicativeReleaseFor(label, { includeWithdrawn: true });
	if (release === null) return null;
	return readIndicativeAt(
		store,
		keys.indicative(release.parameters.version, label),
		release,
		label,
	);
}

/**
 * The indicative print stored at `key`, which must be the print of `label` under `release`: an
 * object for another date or release at this key is corruption, never served.
 */
async function readIndicativeAt(
	store: ObjectStore,
	key: string,
	release: Methodology,
	label: string,
): Promise<IndicativePrint | null> {
	const print = await readJson(store, indicativePrintSchema, key);
	if (print === null) return null;
	if (print.date !== label || !isUnder(release, print)) {
		throw new Error(
			`${key} holds the indicative print of ${print.date} under ${print.methodologyVersion}`,
		);
	}
	return print;
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
		const receipt = decodeReceipt(key, object);
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

/** Every frozen indicative print with a date in [from, to], oldest first. */
export async function readIndicativePrints(
	store: ObjectStore,
	from: string,
	to: string,
): Promise<IndicativePrint[]> {
	const listed = (await store.list(keys.indicativeRoot())).filter((key) => {
		const date = INDICATIVE_KEY.exec(key)?.[2];
		return date !== undefined && date >= from && date <= to;
	});
	const prints = await readInBatches(listed, async (key) => {
		const print = await readJson(store, indicativePrintSchema, key);
		if (print === null) throw new Error(`${key} is listed but could not be read`);
		if (key !== keys.indicative(print.methodologyVersion, print.date))
			throw new Error(`${key} holds the indicative print for ${print.date}`);
		return print;
	});
	return prints.sort((x, y) => x.date.localeCompare(y.date));
}
