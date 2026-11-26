/**
 * The archive: where receipts, raw bodies, day indexes and prints live in the object store, and
 * the rules for writing them. Everything read back is schema-validated. A print or history object
 * is classified by `classifyPrintObject`, never thrown on: one that is not what its key promises
 * is `misfiled`, kept as stored, never served and reported. A receipt counts only at its own key
 * in its own partition; an unreadable one stops settlement rather than silently dropping a round.
 */
import type { z } from 'zod';

import { partitionsOf, settlementDay, slotIndexIn, type DayWindow } from '@/lib/index/calendar';
import { sha256Hex } from '@/lib/index/json';
import {
	activeReleases,
	governsAnyOf,
	isUnder,
	methodologyOf,
	settlementReleaseOrNull,
	SLOT_MINUTES,
	type DayLabel,
	type DayTimeZone,
	type Methodology,
} from '@/lib/index/methodology';
import { RELEASES } from '@/lib/index/releases';
import { buildPrint, finalizePrint, historyEntryOf, printBody } from '@/lib/index/print';
import { receiptHashMatches, summarizeReceipt } from '@/lib/index/round';
import {
	dayIndexSchema,
	historyIndexSchema,
	printSchema,
	receiptSchema,
	type DailyPrint,
	type DayIndex,
	type HistoryEntry,
	type HistoryIndex,
	type RoundReceipt,
	type RoundSummary,
} from '@/lib/index/schemas';
import {
	dayStartMs,
	parseRoundId,
	roundIdFor,
	slotStartMs,
	type RoundId,
	type UtcDate,
} from '@/lib/index/time';

import type { ObjectStore, StoredObject, WriteCondition } from './storage';

export const JSON_TYPE = 'application/json';
export const MAX_CONDITIONAL_ATTEMPTS = 5;
const READ_CONCURRENCY = 16;

export const keys = {
	receipt: (date: UtcDate, id: RoundId) => `rounds/${date}/${id}.json`,
	/** Content-addressed, so a superseding round can never overwrite another round's body. */
	raw: (date: UtcDate, id: RoundId, sha256: string) => `rounds/${date}/${id}.${sha256}.raw`,
	roundsOf: (date: UtcDate) => `rounds/${date}/`,
	dayIndex: (date: UtcDate) => `days/${date}.json`,
	/** Under the release's print root (`printRoot`): v1's UTC days and zoned days never share a key. */
	print: (root: PrintRoot, date: string, revision: number) => `${root}${date}/r${revision}.json`,
	history: (root: PrintRoot) => `${root}history.json`,
	/** Frozen, never revised: one object per indicative day, under the release it is computed in. */
	indicative: (version: string, date: string) => `indicative/${version}/${date}.json`,
	indicativeRoot: () => 'indicative/',
};

/**
 * Where a release's settlement prints and history live. v1's UTC days keep `prints/`; a zoned
 * release's days live under their zone (`prints/et/`), so a stale deployment settling a v2 label
 * as a UTC day can never occupy, block or overwrite a v2 print's key (design §2).
 */
type PrintRoot = 'prints/' | 'prints/et/';
const ZONE_ROOT: Record<DayTimeZone, PrintRoot> = { 'America/New_York': 'prints/et/' };

function printRoot(release: Methodology): PrintRoot {
	const { day } = release.parameters;
	return day === 'utc' ? 'prints/' : ZONE_ROOT[day.timeZone];
}

/** Every print root a registered release uses, so stale writes under any of them can be found. */
const PRINT_ROOTS: readonly PrintRoot[] = [...new Set(RELEASES.map(printRoot))];

/** The print root that owns `date` as a settlement day, or null when no release does. */
function canonicalRoot(date: string): PrintRoot | null {
	const release = settlementReleaseOrNull(date);
	return release === null ? null : printRoot(release);
}

/** The UTC storage partition a round lives in. */
export function dateOf(id: RoundId): UtcDate {
	const parsed = parseRoundId(id);
	if (parsed === null) throw new Error(`invalid round id ${id}`);
	return parsed.partition;
}

/**
 * The storage partition a settlement day is exactly, or null when the day spans partitions (a
 * zoned day). Only such a day is re-indexed by settlement; a partition's index stays owned by
 * collect otherwise (design §5).
 */
function utcPartitionOf(window: DayWindow): UtcDate | null {
	const partitions = partitionsOf(window);
	const [partition] = partitions;
	return partitions.length === 1 &&
		partition !== undefined &&
		dayStartMs(partition) === window.start.getTime()
		? partition
		: null;
}

export function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function decode<T>(schema: z.ZodType<T>, key: string, object: StoredObject): T {
	const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(object.body)));
	if (!parsed.success)
		throw new Error(`stored object ${key} fails its schema: ${parsed.error.message}`);
	return parsed.data;
}

export async function readJson<T>(
	store: ObjectStore,
	schema: z.ZodType<T>,
	key: string,
): Promise<T | null> {
	const object = await store.read(key);
	return object === null ? null : decode(schema, key, object);
}

/** A stored receipt that fails `receiptSchema`, e.g. one recording a release this code lacks. */
export class UnrecognizedReceipt extends Error {}

/**
 * A stored round's receipt, validated against the release and adapter it records, or null when
 * none is stored. A receipt this code cannot validate is never served here (UnrecognizedReceipt).
 */
export async function readReceipt(store: ObjectStore, id: RoundId): Promise<RoundReceipt | null> {
	const key = keys.receipt(dateOf(id), id);
	const object = await store.read(key);
	if (object === null) return null;
	const parsed = receiptSchema.safeParse(JSON.parse(new TextDecoder().decode(object.body)));
	if (!parsed.success) {
		throw new UnrecognizedReceipt(`stored object ${key} fails its schema: ${parsed.error.message}`);
	}
	if (parsed.data.roundId !== id) {
		throw new UnrecognizedReceipt(`${key} holds round ${parsed.data.roundId}`);
	}
	return parsed.data;
}

/** The archived body a receipt cites, or null when the receipt has none. */
export async function readRaw(
	store: ObjectStore,
	receipt: RoundReceipt,
): Promise<Uint8Array | null> {
	if (receipt.rawSha256 === null) return null;
	const key = keys.raw(dateOf(receipt.roundId), receipt.roundId, receipt.rawSha256);
	const object = await store.read(key);
	if (object === null) throw new Error(`${key} is cited by its receipt but missing`);
	return object.body;
}

/**
 * A round can be stored until this long after its slot ends, and never later. Settlement needs
 * this bound: without it, a slow writer could replace an invalid receipt after the day's print
 * was built, and the print would no longer match the archive.
 */
const WRITE_WINDOW_AFTER_SLOT_MS = 60_000;

function writeDeadline(id: RoundId): number {
	const parsed = parseRoundId(id);
	if (parsed === null) throw new Error(`invalid round id ${id}`);
	return parsed.slotStart.getTime() + SLOT_MINUTES * 60_000 + WRITE_WINDOW_AFTER_SLOT_MS;
}

export type RecordOutcome = 'recorded' | 'superseded_invalid' | 'duplicate';
/** `receipt` is the one the archive holds afterwards, which for a duplicate is the earlier one. */
export type RecordResult = { outcome: RecordOutcome; receipt: RoundReceipt };

/**
 * Stores a round. The first valid receipt written for a slot is final. An invalid receipt
 * stands until a valid one is written in the same slot, which replaces it; any other second
 * round is a duplicate and is dropped. A lost conditional write re-reads and re-applies the
 * rule. On every path the day index is then synced from the persisted receipts.
 */
export async function recordRound(
	store: ObjectStore,
	candidate: RoundReceipt,
	body: Uint8Array | null,
	now: Date,
): Promise<RecordResult> {
	const receipt = recordable(candidate, body);
	if (now.getTime() >= writeDeadline(receipt.roundId)) {
		throw new Error(`round ${receipt.roundId} arrived after its write window closed`);
	}
	const date = dateOf(receipt.roundId);
	const key = keys.receipt(date, receipt.roundId);
	if (body !== null && receipt.rawSha256 !== null) {
		// Content-addressed: an object already at this key holds these same bytes.
		const rawKey = keys.raw(date, receipt.roundId, receipt.rawSha256);
		await store.write(rawKey, body, 'application/octet-stream', { kind: 'if-absent' });
	}
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const stored = await store.read(key);
		const existing = stored === null ? null : decode(receiptSchema, key, stored);
		if (
			existing !== null &&
			(existing.observation.status === 'valid' || receipt.observation.status === 'invalid')
		) {
			await syncDayIndex(store, date, { kind: 'collect', refresh: receipt.roundId });
			return { outcome: 'duplicate', receipt: existing };
		}
		const condition: WriteCondition =
			stored === null ? { kind: 'if-absent' } : { kind: 'if-version', version: stored.version };
		if ((await store.write(key, encode(receipt), JSON_TYPE, condition)) === 'written') {
			await syncDayIndex(store, date, { kind: 'collect', refresh: receipt.roundId });
			return { outcome: existing === null ? 'recorded' : 'superseded_invalid', receipt };
		}
	}
	throw new Error(`${key}: gave up after ${MAX_CONDITIONAL_ATTEMPTS} conflicting writes`);
}

/**
 * The schema-parsed receipt, after checking its hash and its body. Only this parsed value is
 * persisted, so nothing that would later fail verification (and wedge settlement) is stored.
 */
function recordable(candidate: RoundReceipt, body: Uint8Array | null): RoundReceipt {
	const receipt = receiptSchema.parse(candidate);
	const fetchedAt = new Date(receipt.fetchedAt);
	if (
		receipt.roundId !== roundIdFor(fetchedAt) ||
		receipt.slotStart !== new Date(slotStartMs(fetchedAt)).toISOString()
	)
		throw new Error(`receipt ${receipt.roundId} is not in the slot of its fetchedAt`);
	if (!receiptHashMatches(receipt))
		throw new Error(`receipt ${receipt.roundId} does not match its receiptHash`);
	const bodyMatches =
		body === null
			? receipt.rawSha256 === null && receipt.rawBytes === null
			: sha256Hex(body) === receipt.rawSha256 && body.byteLength === receipt.rawBytes;
	if (!bodyMatches)
		throw new Error(`receipt ${receipt.roundId} does not describe the body it came with`);
	return receipt;
}

function emptyDayIndex(date: UtcDate): DayIndex {
	return { schema: 'adi.day-index/1', date, rounds: [] };
}

/**
 * The day index: one summary per stored round, so the running value needs a single read. One that
 * does not decode is rebuilt from the partition's receipts, never thrown on: under v1 the next
 * collect would rebuild it, but under v2 nothing rewrites a partition once its UTC day is over,
 * while the ET day still reads it for five hours (#34). A rebuild that cannot read every receipt is
 * served without the unreadable ones but never stored, so the next read rebuilds it again.
 */
export async function readDayIndex(store: ObjectStore, date: UtcDate): Promise<DayIndex> {
	const object = await store.read(keys.dayIndex(date));
	if (object === null) return emptyDayIndex(date);
	return tryDecode(dayIndexSchema, object) ?? syncDayIndex(store, date, { kind: 'repair' });
}

/**
 * What brings the index up to date: a collect that just resolved `refresh`, a settle, or a repair
 * of an index that does not decode.
 */
type IndexSync =
	| { kind: 'collect'; refresh: RoundId }
	| { kind: 'settle'; receipts: readonly RoundReceipt[] }
	| { kind: 'repair' };

/**
 * The one owner of the day index, which it keeps in line with the stored receipts.
 * - On collect: one listing of the day's receipts. The round just resolved is re-read from its
 *   persisted receipt (inside the conditional write, so a stale writer retries), plus at most 15
 *   others (READ_CONCURRENCY - 1): listed receipts missing from the index first, then rounds the
 *   index holds as invalid, newest slot first, the only kind a later write can replace. Another round's receipt that
 *   cannot be read is skipped and retried next time. An index that does not decode is rebuilt
 *   from every listed receipt plus the round just resolved.
 * - On settle: rebuilt from the receipts settle already read.
 * - On repair: unless another writer already fixed it, rebuilt from every listed receipt. If one
 *   cannot be read, the rebuilt index is returned without it but not stored: a repaired partition
 *   is one no collect rewrites any more, so a stored index missing a round would never regain it.
 * A rebuild ignores the old content and uses only its version. Returns the index as stored.
 */
async function syncDayIndex(store: ObjectStore, date: UtcDate, sync: IndexSync): Promise<DayIndex> {
	const key = keys.dayIndex(date);
	const listed = sync.kind === 'settle' ? [] : await listReceiptIds(store, date);
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const object = await store.read(key);
		const current = object === null ? emptyDayIndex(date) : tryDecode(dayIndexSchema, object);
		let rounds: RoundSummary[];
		let partial = false;
		if (sync.kind === 'settle') {
			rounds = sync.receipts.map(summarizeReceipt);
		} else if (sync.kind === 'repair') {
			if (current !== null) return current;
			const receipts = await readReceipts(store, date, listed, 'skip');
			rounds = receipts.map(summarizeReceipt);
			partial = receipts.length < listed.length;
		} else if (current === null) {
			// The listing can lag the write that just happened, so the own round is always read.
			const all = [sync.refresh, ...listed.filter((id) => id !== sync.refresh)];
			rounds = (await readCollected(store, date, sync.refresh, all)).map(summarizeReceipt);
		} else {
			// Only an invalid receipt can change (a valid one may replace it), so invalid entries
			// are re-read too, after missing ones, within the same budget.
			const indexed = new Set(current.rounds.map((r) => r.roundId));
			const missing = listed.filter((id) => !indexed.has(id) && id !== sync.refresh);
			// Newest first: a supersede whose patch failed is always in a recent slot.
			const invalid = current.rounds
				.filter((r) => r.observation.status === 'invalid' && r.roundId !== sync.refresh)
				.map((r) => r.roundId)
				.sort((x, y) => y.localeCompare(x));
			const toRead = [sync.refresh, ...[...missing, ...invalid].slice(0, READ_CONCURRENCY - 1)];
			const fresh = (await readCollected(store, date, sync.refresh, toRead)).map(summarizeReceipt);
			const reread = new Set(fresh.map((r) => r.roundId));
			rounds = [...current.rounds.filter((r) => !reread.has(r.roundId)), ...fresh];
		}
		const index: DayIndex = {
			...emptyDayIndex(date),
			rounds: rounds.sort((x, y) => x.roundId.localeCompare(y.roundId)),
		};
		if (partial) return index;
		const next = encode(index);
		if (object !== null && Buffer.from(next).equals(Buffer.from(object.body))) return index;
		const condition: WriteCondition =
			object === null ? { kind: 'if-absent' } : { kind: 'if-version', version: object.version };
		if ((await store.write(key, next, JSON_TYPE, condition)) === 'written') return index;
	}
	throw new Error(`${key}: gave up after ${MAX_CONDITIONAL_ATTEMPTS} conflicting writes`);
}

/**
 * Reads for a collect's index sync. Another round's unreadable receipt is skipped, so it stays
 * out of the index and is retried on the next collect instead of failing every collect; the
 * round this collect just stored must be readable.
 */
async function readCollected(
	store: ObjectStore,
	date: UtcDate,
	refresh: RoundId,
	ids: readonly RoundId[],
): Promise<RoundReceipt[]> {
	const receipts = await readReceipts(store, date, ids, 'skip');
	if (!receipts.some((r) => r.roundId === refresh)) {
		throw new Error(`receipt ${refresh} could not be read after it was stored`);
	}
	return receipts;
}

/** The stored object decoded, or null when it is not valid JSON of that schema. */
function tryDecode<T>(schema: z.ZodType<T>, object: StoredObject): T | null {
	try {
		const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(object.body)));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** The round ids stored under partition `date`. An id from another partition is not its receipt. */
async function listReceiptIds(store: ObjectStore, date: UtcDate): Promise<RoundId[]> {
	const prefix = keys.roundsOf(date);
	return (await store.list(prefix))
		.filter((key) => key.endsWith('.json'))
		.map((key) => key.slice(prefix.length, -'.json'.length))
		.filter((id) => parseRoundId(id)?.partition === date);
}

/**
 * The given rounds' receipts, read READ_CONCURRENCY at a time, each verified against its hash.
 * `unreadable: 'skip'` leaves out a receipt that cannot be read, decoded or verified; 'throw'
 * fails on it.
 */
/** `read` applied to every item, READ_CONCURRENCY at a time, results in item order. */
export async function readInBatches<T, R>(
	items: readonly T[],
	read: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += READ_CONCURRENCY) {
		results.push(...(await Promise.all(items.slice(i, i + READ_CONCURRENCY).map(read))));
	}
	return results;
}

async function readReceipts(
	store: ObjectStore,
	date: UtcDate,
	ids: readonly RoundId[],
	unreadable: 'throw' | 'skip',
): Promise<RoundReceipt[]> {
	const receipts = await readInBatches(ids, async (id) => {
		const key = keys.receipt(date, id);
		try {
			const receipt = await readJson(store, receiptSchema, key);
			if (receipt === null) throw new Error(`receipt ${key} is listed but could not be read`);
			if (receipt.roundId !== id) throw new Error(`${key} holds round ${receipt.roundId}`);
			if (!receiptHashMatches(receipt))
				throw new Error(`receipt ${key} does not match its receiptHash`);
			return receipt;
		} catch (error) {
			if (unreadable === 'skip') return null;
			throw error;
		}
	});
	return receipts.filter((receipt) => receipt !== null);
}

/** Every receipt stored for `date`, each verified against its own hash. */
export async function readDayReceipts(store: ObjectStore, date: UtcDate): Promise<RoundReceipt[]> {
	return readReceipts(store, date, await listReceiptIds(store, date), 'throw');
}

/**
 * The stored receipt ids whose slot is in `window`, with the UTC partition each is stored in.
 * Filtered by id before anything is read, so a receipt outside the window is never read and can
 * never stop a run.
 */
export async function listWindowReceipts(
	store: ObjectStore,
	window: DayWindow,
): Promise<{ partition: UtcDate; id: RoundId }[]> {
	const inWindow = (id: RoundId) => {
		const parsed = parseRoundId(id);
		return parsed !== null && slotIndexIn(window, parsed.slotStart) !== null;
	};
	const listed = await Promise.all(
		partitionsOf(window).map(async (partition) =>
			(await listReceiptIds(store, partition)).filter(inWindow).map((id) => ({ partition, id })),
		),
	);
	return listed.flat();
}

/** Every stored receipt whose slot is in `window`, across its partitions, each verified. */
async function readWindowReceipts(store: ObjectStore, window: DayWindow): Promise<RoundReceipt[]> {
	const listed = await listWindowReceipts(store, window);
	const partitions = [...new Set(listed.map((entry) => entry.partition))];
	const read = await Promise.all(
		partitions.map((partition) =>
			readReceipts(
				store,
				partition,
				listed.filter((entry) => entry.partition === partition).map((entry) => entry.id),
				'throw',
			),
		),
	);
	return read.flat();
}

/**
 * Why `print`, stored at `key`, is not a print this archive serves, or null when it is: it must be
 * revision `print.revision` of `print.date`, under the release that owns that date, at that
 * release's root.
 */
function printKeyProblem(key: string, print: DailyPrint): string | null {
	const release = settlementReleaseOrNull(print.date);
	if (release === null) return `${key} holds a print of ${print.date}, which no release owns`;
	const expected = keys.print(printRoot(release), print.date, print.revision);
	if (key !== expected) return `${key} holds the print for ${expected}`;
	if (!isUnder(release, print)) {
		return `${key} records ${print.methodologyVersion}, not the release that owns ${print.date}`;
	}
	return null;
}

/** What an object under a print root is. Anything this archive does not serve is `misfiled`. */
type PrintObject =
	| { kind: 'print'; print: DailyPrint }
	/** `foreignDates`: entries for dates another root owns (a stale deployment's), never served. */
	| { kind: 'history'; days: HistoryEntry[]; foreignDates: string[] }
	| { kind: 'misfiled'; reason: string };

/**
 * The one classifier of stored print and history objects, used by every reader of them (day,
 * corrections, history, misfiled, settle). It never throws on stored content. A history key must
 * hold a history index; any other key must hold a print that passes `printKeyProblem`.
 */
function classifyPrintObject(key: string, bytes: Uint8Array): PrintObject {
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { kind: 'misfiled', reason: `${key} is not JSON` };
	}
	const historyRoot = PRINT_ROOTS.find((root) => key === keys.history(root));
	if (historyRoot !== undefined) {
		const history = historyIndexSchema.safeParse(body);
		if (!history.success) return { kind: 'misfiled', reason: `${key} is not a history index` };
		const owned = (day: HistoryEntry) => canonicalRoot(day.date) === historyRoot;
		return {
			kind: 'history',
			days: history.data.days.filter(owned),
			foreignDates: history.data.days.filter((day) => !owned(day)).map((day) => day.date),
		};
	}
	const print = printSchema.safeParse(body);
	if (!print.success) return { kind: 'misfiled', reason: `${key} is not a settlement print` };
	const problem = printKeyProblem(key, print.data);
	return problem === null
		? { kind: 'print', print: print.data }
		: { kind: 'misfiled', reason: problem };
}

/** A print key whose object is not that print: the revisions of its day stop before it. */
type BlockedKey = { key: string; reason: string };

/**
 * A day's revisions, oldest first, from the print root of the release that owns the day, up to
 * the first key that is empty or holds something else (`blocked`). None when no release owns it.
 */
async function readRevisions(
	store: ObjectStore,
	date: string,
): Promise<{ prints: DailyPrint[]; blocked: BlockedKey | null }> {
	const release = settlementReleaseOrNull(date);
	const prints: DailyPrint[] = [];
	if (release === null) return { prints, blocked: null };
	for (let revision = 1; ; revision += 1) {
		const key = keys.print(printRoot(release), date, revision);
		const object = await store.read(key);
		if (object === null) return { prints, blocked: null };
		const classified = classifyPrintObject(key, object.body);
		if (classified.kind !== 'print') {
			const reason = classified.kind === 'misfiled' ? classified.reason : `${key} is a history`;
			return { prints, blocked: { key, reason } };
		}
		prints.push(classified.print);
	}
}

/**
 * All revisions of a day's print, oldest first: the last valid revision is the one served, and
 * an object past it that is not the next revision is reported by `misfiledPrints`.
 */
export async function readPrints(store: ObjectStore, date: string): Promise<DailyPrint[]> {
	return (await readRevisions(store, date)).prints;
}

/** Objects for a date that no reader serves, reported under the design's problem code. */
export type MisfiledPrints = { problem: 'misfiled_print'; objects: string[] };

/** Whether `object` is misfiled for `date`: not what its key promises, or a history listing it. */
function misfiledFor(object: PrintObject, date: string): boolean {
	return (
		object.kind === 'misfiled' || (object.kind === 'history' && object.foreignDates.includes(date))
	);
}

/**
 * What no reader serves for `date`: print objects under a root other than the one its release
 * owns, objects under that root that do not classify as its prints, and any history that is not
 * one or lists the date under a root that does not own it. Reported so the monitor can alert;
 * null when there are none.
 */
export async function misfiledPrints(
	store: ObjectStore,
	date: string,
): Promise<MisfiledPrints | null> {
	const canonical = canonicalRoot(date);
	const found = await Promise.all(
		PRINT_ROOTS.map(async (root) => {
			const listed = await store.list(`${root}${date}/`);
			const historyKey = keys.history(root);
			const classified = await readInBatches(
				root === canonical ? [...listed, historyKey] : [historyKey],
				async (key) => {
					const object = await store.read(key);
					return object !== null && misfiledFor(classifyPrintObject(key, object.body), date)
						? [key]
						: [];
				},
			);
			return root === canonical ? classified.flat() : [...listed, ...classified.flat()];
		}),
	);
	const objects = found.flat();
	return objects.length === 0 ? null : { problem: 'misfiled_print', objects };
}

const PRINT_KEY = /^(prints\/(?:[a-z]+\/)?)(\d{4}-\d{2}-\d{2})\/r(\d+)\.json$/;

/**
 * The dates with a print key of at least `minRevision` under `prefix`, counting only keys under
 * the root that owns their date: an object under another root is never read.
 */
async function canonicalPrintDates(
	store: ObjectStore,
	prefix: string,
	minRevision: number,
): Promise<string[]> {
	const dates = (await store.list(prefix)).flatMap((key) => {
		const [, root, date, revision] = PRINT_KEY.exec(key) ?? [];
		return date !== undefined && Number(revision) >= minRevision && root === canonicalRoot(date)
			? [date]
			: [];
	});
	return [...new Set(dates)];
}

/**
 * Every served correction print (revision 2 or later), found by listing the print keys rather
 * than the history index, which can lag a correction whose history update failed. Each day is
 * read through `readPrints`, so a correction is listed exactly when its day serves it.
 */
export async function readCorrectionPrints(store: ObjectStore): Promise<DailyPrint[]> {
	const days = await readInBatches(await canonicalPrintDates(store, 'prints/', 2), (date) =>
		readPrints(store, date),
	);
	return days.flat().filter((print) => print.revision > 1);
}

/**
 * A settlement day's receipts, each verified. A UTC day is one whole partition, read as v1
 * always has and re-indexed from what was read; a zoned day spans two partitions, read through
 * its window, and leaves their indexes to collect.
 */
async function readSettlementReceipts(
	store: ObjectStore,
	window: DayWindow,
): Promise<RoundReceipt[]> {
	const partition = utcPartitionOf(window);
	if (partition === null) return readWindowReceipts(store, window);
	const receipts = await readDayReceipts(store, partition);
	await syncDayIndex(store, partition, { kind: 'settle', receipts });
	return receipts;
}

export type SettleOutcome = { status: 'settled' | 'already_settled'; print: DailyPrint };

/**
 * Builds and stores revision 1 of a day's print from its receipts. A UTC day also rebuilds its
 * partition's day index from those same receipts; a zoned day leaves both partitions' indexes to
 * collect. Never overwrites a print. Every path ends by pointing the history index at the day's
 * latest revision.
 */
export async function settleDay(store: ObjectStore, date: DayLabel): Promise<SettleOutcome> {
	const day = settlementDay(date);
	const { prints, blocked } = await readRevisions(store, date);
	const settled = prints.at(-1);
	if (settled !== undefined) {
		await updateHistory(store, settled);
		return { status: 'already_settled', print: settled };
	}
	// r1's key holds something that is not this day's print: nothing else is read or written.
	if (blocked !== null) throw await settlementBlocked(store, date, blocked);
	const receipts = await readSettlementReceipts(store, day.window);
	const print = buildPrint(day, receipts.map(summarizeReceipt), { revision: 1 });
	const key = keys.print(printRoot(day.release), date, 1);
	const written = await store.write(key, encode(print), JSON_TYPE, {
		kind: 'if-absent',
	});
	if (written === 'conflict') {
		// Another settle won. Its print may not be readable yet; give it a few reads, then fail loudly.
		for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
			const raced = await readRevisions(store, date);
			const winner = raced.prints.at(-1);
			if (winner !== undefined) {
				await updateHistory(store, winner);
				return { status: 'already_settled', print: winner };
			}
			if (raced.blocked !== null) throw await settlementBlocked(store, date, raced.blocked);
		}
		throw new Error(`print ${date} r1 exists but could not be read`);
	}
	await updateHistory(store, print);
	return { status: 'settled', print };
}

/** The report for a day whose r1 key is `blocked`, with everything else misfiled for it. */
async function settlementBlocked(
	store: ObjectStore,
	date: string,
	blocked: BlockedKey,
): Promise<SettlementBlocked> {
	const others = (await misfiledPrints(store, date))?.objects ?? [];
	const objects = others.includes(blocked.key) ? others : [blocked.key, ...others];
	return new SettlementBlocked(date, { problem: 'misfiled_print', objects });
}

/** A day whose revision-1 key is held by an object that is not its print, so it cannot settle. */
export class SettlementBlocked extends Error {
	constructor(
		readonly date: string,
		readonly misfiled: MisfiledPrints,
	) {
		super(`${date} cannot settle: its print key is held by ${misfiled.objects.join(', ')}`);
	}
}

/** What the operator states when issuing a correction (scripts/correct.ts). */
export type CorrectionRequest = {
	supersedesPrintHash: string;
	reason: string;
	/** Required after the corrections window, refused inside it (see the print schema). */
	windowOverride: string | null;
};

/**
 * Issues a correction: rebuilds the day from its stored receipts and writes it as the next
 * revision. `clock()` is read after aggregation, just before the write, so a rebuild that runs
 * past the corrections window is judged at its real issue time.
 *
 * Refuses unless `supersedesPrintHash` is the day's latest revision, and refuses a day whose
 * print records a methodology other than the one the rebuild uses. Earlier revisions are never
 * touched; the history index then cites the new revision.
 */
export async function correctDay(
	store: ObjectStore,
	date: DayLabel,
	request: CorrectionRequest,
	clock: () => Date,
): Promise<DailyPrint> {
	const { prints: revisions, blocked } = await readRevisions(store, date);
	const latest = revisions.at(-1);
	if (latest === undefined)
		throw new Error(`${date} has not settled, so it has nothing to correct`);
	if (blocked !== null) {
		throw new Error(`${blocked.reason}, so ${date} cannot take a correction; nothing was changed`);
	}
	if (latest.printHash !== request.supersedesPrintHash) {
		const superseded = revisions.find((p) => p.printHash === request.supersedesPrintHash);
		throw new Error(
			superseded === undefined
				? `${request.supersedesPrintHash} is not a print of ${date}`
				: `${request.supersedesPrintHash} is r${superseded.revision}, but the latest revision of ${date} is r${latest.revision} (${latest.printHash})`,
		);
	}
	const day = settlementDay(date);
	if (!isUnder(day.release, latest)) {
		throw new Error(
			`r${latest.revision} records methodology ${latest.methodologyVersion} (${latest.parameterHash}), not the one in effect on ${date}; a correction never changes a day's methodology`,
		);
	}
	const receipts = await readSettlementReceipts(store, day.window);
	const revision = latest.revision + 1;
	const body = printBody(day, receipts.map(summarizeReceipt));
	// Finalizing checks issuedAt against the window, so the clock is read after aggregation,
	// immediately before the conditional write.
	const print = finalizePrint(body, {
		revision,
		correction: { ...request, issuedAt: clock().toISOString() },
	});
	const key = keys.print(printRoot(day.release), date, revision);
	const written = await store.write(key, encode(print), JSON_TYPE, {
		kind: 'if-absent',
	});
	if (written === 'conflict')
		throw new Error(`${date} r${revision} was written by someone else; nothing was changed`);
	await updateHistory(store, print).catch((error: unknown) => {
		// settleDay points the history at the latest revision, so settling the day again repairs it.
		throw new Error(
			`${date} r${revision} is written, but the history index still cites the previous revision (${String(error)}); settle ${date} again to repair it`,
		);
	});
	return print;
}

const EMPTY_HISTORY: HistoryIndex = { schema: 'adi.history/1', days: [] };

/** Settled days in a range, and any history object in it that could not be read. */
export type HistoryRead = { days: HistoryEntry[]; misfiled: MisfiledPrints | null };

/**
 * The settled days in [from, to], read only from the histories of the roots that own a date in
 * the range, and only for the days each root owns: an entry a stale deployment wrote under the
 * wrong root is never served. A history that does not classify is reported, never thrown on.
 */
export async function readHistory(
	store: ObjectStore,
	from: DayLabel,
	to: DayLabel,
): Promise<HistoryRead> {
	const owning = activeReleases().filter((release) => governsAnyOf(release, from, to));
	const read = await Promise.all(
		[...new Set(owning.map(printRoot))].map(async (root) => {
			const key = keys.history(root);
			const object = await store.read(key);
			const classified = object === null ? null : classifyPrintObject(key, object.body);
			if (classified === null) return { days: [], misfiled: [] };
			if (classified.kind === 'history') return { days: classified.days, misfiled: [] };
			return { days: [], misfiled: [key] };
		}),
	);
	const misfiled = read.flatMap((root) => root.misfiled);
	return {
		days: read
			.flatMap((root) => root.days)
			.filter((day) => day.date >= from && day.date <= to)
			.sort((x, y) => x.date.localeCompare(y.date)),
		misfiled: misfiled.length === 0 ? null : { problem: 'misfiled_print', objects: misfiled },
	};
}

/**
 * Points a root's history at `print`, never regressing a day's revision. The history is only an
 * index of the root's prints, so one that does not classify is rebuilt from them; entries for
 * dates the root does not own are dropped.
 */
async function updateHistory(store: ObjectStore, print: DailyPrint): Promise<void> {
	const entry = historyEntryOf(print);
	const release = methodologyOf(print.methodologyVersion, print.parameterHash);
	if (release === null) throw new Error(`${print.date} records an unknown methodology`);
	const root = printRoot(release);
	const key = keys.history(root);
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const object = await store.read(key);
		const classified = object === null ? null : classifyPrintObject(key, object.body);
		const days =
			classified === null
				? []
				: classified.kind === 'history'
					? classified.days
					: await rebuiltHistory(store, root);
		const listed = days.find((d) => d.date === entry.date);
		const next =
			listed !== undefined && listed.revision > entry.revision
				? days
				: [...days.filter((d) => d.date !== entry.date), entry];
		const body = encode({
			...EMPTY_HISTORY,
			days: next.sort((x, y) => x.date.localeCompare(y.date)),
		});
		if (object !== null && Buffer.from(body).equals(Buffer.from(object.body))) return;
		const condition: WriteCondition =
			object === null ? { kind: 'if-absent' } : { kind: 'if-version', version: object.version };
		if ((await store.write(key, body, JSON_TYPE, condition)) === 'written') return;
	}
	throw new Error(`${key}: gave up after ${MAX_CONDITIONAL_ATTEMPTS} conflicting writes`);
}

/** A root's history rebuilt from its prints: one entry per day, at its served revision. */
async function rebuiltHistory(store: ObjectStore, root: PrintRoot): Promise<HistoryEntry[]> {
	const dates = (await canonicalPrintDates(store, root, 1)).filter(
		(date) => canonicalRoot(date) === root,
	);
	const latest = await readInBatches(dates, async (date) => (await readPrints(store, date)).at(-1));
	return latest.flatMap((print) => (print === undefined ? [] : [historyEntryOf(print)]));
}
