/**
 * The archive: where receipts, raw bodies, day indexes and prints live in the object store, and
 * the rules for writing them. Everything read back is schema-validated; a stored object that
 * fails validation is corruption and throws rather than being skipped.
 */
import type { z } from 'zod';

import {
	dayWindow,
	partitionsOf,
	settlementDay,
	slotIndexIn,
	type DayWindow,
} from '@/lib/index/calendar';
import {
	indicativeAdmissionFor,
	indicativeFreezesAt,
	indicativeReleaseFor,
} from '@/lib/index/indicative';
import { sha256Hex } from '@/lib/index/json';
import { isUnder, SLOT_MINUTES } from '@/lib/index/methodology';
import {
	buildIndicativePrint,
	buildPrint,
	finalizePrint,
	historyEntryOf,
	printBody,
} from '@/lib/index/print';
import { receiptHashMatches, summarizeReceipt } from '@/lib/index/round';
import {
	dayIndexSchema,
	historyIndexSchema,
	indicativePrintSchema,
	printSchema,
	receiptSchema,
	type DailyPrint,
	type DayIndex,
	type HistoryIndex,
	type IndicativePrint,
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

const JSON_TYPE = 'application/json';
const MAX_CONDITIONAL_ATTEMPTS = 5;
const READ_CONCURRENCY = 16;

const keys = {
	receipt: (date: UtcDate, id: RoundId) => `rounds/${date}/${id}.json`,
	/** Content-addressed, so a superseding round can never overwrite another round's body. */
	raw: (date: UtcDate, id: RoundId, sha256: string) => `rounds/${date}/${id}.${sha256}.raw`,
	roundsOf: (date: UtcDate) => `rounds/${date}/`,
	dayIndex: (date: UtcDate) => `days/${date}.json`,
	print: (date: UtcDate, revision: number) => `prints/${date}/r${revision}.json`,
	history: () => 'prints/history.json',
	/** Frozen, never revised: one object per indicative day, under the release it is computed in. */
	indicative: (version: string, date: string) => `indicative/${version}/${date}.json`,
	indicativeRoot: () => 'indicative/',
};

/** The UTC storage partition a round lives in. */
function dateOf(id: RoundId): UtcDate {
	const parsed = parseRoundId(id);
	if (parsed === null) throw new Error(`invalid round id ${id}`);
	return parsed.partition;
}

/**
 * The one storage partition holding every slot of a settlement day. Settlement here reads, and
 * re-indexes, a single partition, which is exactly a v1 UTC day. A day in a zoned release spans
 * two partitions and is refused until settlement reads windows across partitions.
 */
function partitionOfDay(window: DayWindow): UtcDate {
	const partitions = partitionsOf(window);
	const [partition] = partitions;
	if (
		partitions.length !== 1 ||
		partition === undefined ||
		dayStartMs(partition) !== window.start.getTime()
	)
		throw new Error(
			`${window.date} spans storage partitions ${partitions.join(', ')}; only a UTC day can be settled here`,
		);
	return partition;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

function decode<T>(schema: z.ZodType<T>, key: string, object: StoredObject): T {
	const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(object.body)));
	if (!parsed.success)
		throw new Error(`stored object ${key} fails its schema: ${parsed.error.message}`);
	return parsed.data;
}

async function readJson<T>(
	store: ObjectStore,
	schema: z.ZodType<T>,
	key: string,
): Promise<T | null> {
	const object = await store.read(key);
	return object === null ? null : decode(schema, key, object);
}

export async function readReceipt(store: ObjectStore, id: RoundId): Promise<RoundReceipt | null> {
	return readJson(store, receiptSchema, keys.receipt(dateOf(id), id));
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

/** The day index: one summary per stored round, so the running value needs a single read. */
export async function readDayIndex(store: ObjectStore, date: UtcDate): Promise<DayIndex> {
	return (await readJson(store, dayIndexSchema, keys.dayIndex(date))) ?? emptyDayIndex(date);
}

/** What brought the index up to date: a collect that just resolved `refresh`, or a settle. */
type IndexSync =
	{ kind: 'collect'; refresh: RoundId } | { kind: 'settle'; receipts: readonly RoundReceipt[] };

/**
 * The one owner of the day index, which it keeps in line with the stored receipts.
 * - On collect: one listing of the day's receipts. The round just resolved is re-read from its
 *   persisted receipt (inside the conditional write, so a stale writer retries), plus at most 15
 *   others (READ_CONCURRENCY - 1): listed receipts missing from the index first, then rounds the
 *   index holds as invalid, newest slot first, the only kind a later write can replace. Another round's receipt that
 *   cannot be read is skipped and retried next time. An index that does not decode is rebuilt
 *   from every listed receipt plus the round just resolved.
 * - On settle: rebuilt from the receipts settle already read.
 * A rebuild ignores the old content and uses only its version.
 */
async function syncDayIndex(store: ObjectStore, date: UtcDate, sync: IndexSync): Promise<void> {
	const key = keys.dayIndex(date);
	const listed = sync.kind === 'collect' ? await listReceiptIds(store, date) : [];
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const object = await store.read(key);
		const current = object === null ? emptyDayIndex(date) : tryDecode(dayIndexSchema, object);
		let rounds: RoundSummary[];
		if (sync.kind === 'settle') {
			rounds = sync.receipts.map(summarizeReceipt);
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
		const next = encode({
			...emptyDayIndex(date),
			rounds: rounds.sort((x, y) => x.roundId.localeCompare(y.roundId)),
		});
		if (object !== null && Buffer.from(next).equals(Buffer.from(object.body))) return;
		const condition: WriteCondition =
			object === null ? { kind: 'if-absent' } : { kind: 'if-version', version: object.version };
		if ((await store.write(key, next, JSON_TYPE, condition)) === 'written') return;
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

/** Read-modify-write with optimistic concurrency on the object's version. */
async function updateJson<T>(
	store: ObjectStore,
	schema: z.ZodType<T>,
	key: string,
	empty: T,
	change: (current: T) => T | Promise<T>,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const object = await store.read(key);
		const current = object === null ? empty : decode(schema, key, object);
		const next = encode(await change(current));
		if (object !== null && Buffer.from(next).equals(Buffer.from(object.body))) return;
		const condition: WriteCondition =
			object === null ? { kind: 'if-absent' } : { kind: 'if-version', version: object.version };
		if ((await store.write(key, next, JSON_TYPE, condition)) === 'written') return;
	}
	throw new Error(`${key}: gave up after ${MAX_CONDITIONAL_ATTEMPTS} conflicting writes`);
}

async function listReceiptIds(store: ObjectStore, date: UtcDate): Promise<RoundId[]> {
	const prefix = keys.roundsOf(date);
	return (await store.list(prefix))
		.filter((key) => key.endsWith('.json'))
		.map((key) => key.slice(prefix.length, -'.json'.length));
}

/**
 * The given rounds' receipts, read READ_CONCURRENCY at a time, each verified against its hash.
 * `unreadable: 'skip'` leaves out a receipt that cannot be read, decoded or verified; 'throw'
 * fails on it.
 */
/** `read` applied to every item, READ_CONCURRENCY at a time, results in item order. */
async function readInBatches<T, R>(
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
 * Every stored receipt whose slot is in `window`, across the window's UTC partitions, each
 * verified against its own hash. Ids are filtered to the window before anything is read, so a
 * receipt outside the window is never read and can never stop a run.
 */
export async function readWindowReceipts(
	store: ObjectStore,
	window: DayWindow,
): Promise<RoundReceipt[]> {
	const inWindow = (id: RoundId) => {
		const parsed = parseRoundId(id);
		return parsed !== null && slotIndexIn(window, parsed.slotStart) !== null;
	};
	const partitions = await Promise.all(
		partitionsOf(window).map(async (partition) =>
			readReceipts(
				store,
				partition,
				(await listReceiptIds(store, partition)).filter(inWindow),
				'throw',
			),
		),
	);
	return partitions.flat();
}

/** All revisions of a day's print, oldest first. Empty when the day has not settled. */
export async function readPrints(store: ObjectStore, date: UtcDate): Promise<DailyPrint[]> {
	const prints: DailyPrint[] = [];
	for (let revision = 1; ; revision += 1) {
		const print = await readJson(store, printSchema, keys.print(date, revision));
		if (print === null) return prints;
		prints.push(print);
	}
}

const PRINT_KEY = /^prints\/(\d{4}-\d{2}-\d{2})\/r(\d+)\.json$/;

/**
 * Every stored correction print (revision 2 or later), found by listing the print keys. It does
 * not rely on the history index, which can lag a correction whose history update failed.
 */
export async function readCorrectionPrints(store: ObjectStore): Promise<DailyPrint[]> {
	const listed = (await store.list('prints/')).filter(
		(key) => Number(PRINT_KEY.exec(key)?.[2]) > 1,
	);
	return readInBatches(listed, async (key) => {
		const print = await readJson(store, printSchema, key);
		if (print === null) throw new Error(`${key} is listed but could not be read`);
		const expected = keys.print(print.date, print.revision);
		if (key !== expected) throw new Error(`${key} holds the print for ${expected}`);
		return print;
	});
}

export type SettleOutcome = { status: 'settled' | 'already_settled'; print: DailyPrint };

/**
 * Builds and stores revision 1 of a day's print from its receipts, and rebuilds the day index
 * from those same receipts. Never overwrites a print. Every path ends by pointing the history
 * index at the day's latest revision.
 */
export async function settleDay(store: ObjectStore, date: UtcDate): Promise<SettleOutcome> {
	// Resolved first, so a day this build cannot settle never reaches the history index either.
	const day = settlementDay(date);
	const partition = partitionOfDay(day.window);
	const settled = (await readPrints(store, date)).at(-1);
	if (settled !== undefined) {
		await updateHistory(store, settled);
		return { status: 'already_settled', print: settled };
	}
	const receipts = await readDayReceipts(store, partition);
	await syncDayIndex(store, partition, { kind: 'settle', receipts });
	const print = buildPrint(day, receipts.map(summarizeReceipt), { revision: 1 });
	const written = await store.write(keys.print(date, 1), encode(print), JSON_TYPE, {
		kind: 'if-absent',
	});
	if (written === 'conflict') {
		// Another settle won. Its print may not be readable yet; give it a few reads, then fail loudly.
		for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
			const winner = (await readPrints(store, date)).at(-1);
			if (winner !== undefined) {
				await updateHistory(store, winner);
				return { status: 'already_settled', print: winner };
			}
		}
		throw new Error(`print ${date} r1 exists but could not be read`);
	}
	await updateHistory(store, print);
	return { status: 'settled', print };
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
	date: UtcDate,
	request: CorrectionRequest,
	clock: () => Date,
): Promise<DailyPrint> {
	const revisions = await readPrints(store, date);
	const latest = revisions.at(-1);
	if (latest === undefined)
		throw new Error(`${date} has not settled, so it has nothing to correct`);
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
	const partition = partitionOfDay(day.window);
	const receipts = await readDayReceipts(store, partition);
	await syncDayIndex(store, partition, { kind: 'settle', receipts });
	const revision = latest.revision + 1;
	const body = printBody(day, receipts.map(summarizeReceipt));
	// Finalizing checks issuedAt against the window, so the clock is read after aggregation,
	// immediately before the conditional write.
	const print = finalizePrint(body, {
		revision,
		correction: { ...request, issuedAt: clock().toISOString() },
	});
	const written = await store.write(keys.print(date, revision), encode(print), JSON_TYPE, {
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

export async function readHistory(store: ObjectStore): Promise<HistoryIndex> {
	return (await readJson(store, historyIndexSchema, keys.history())) ?? EMPTY_HISTORY;
}

async function updateHistory(store: ObjectStore, print: DailyPrint): Promise<void> {
	const entry = historyEntryOf(print);
	await updateJson(store, historyIndexSchema, keys.history(), EMPTY_HISTORY, (history) => {
		const listed = history.days.find((d) => d.date === entry.date);
		if (listed !== undefined && listed.revision > entry.revision) return history; // never regress
		return {
			...history,
			days: [...history.days.filter((d) => d.date !== entry.date), entry].sort((x, y) =>
				x.date.localeCompare(y.date),
			),
		};
	});
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
	const stored = await readJson(store, indicativePrintSchema, key);
	if (stored !== null) return { status: 'already_frozen', print: stored };
	const receipts = await readWindowReceipts(store, window);
	const print = buildIndicativePrint(
		{ release, window },
		receipts.map(summarizeReceipt),
		admission,
	);
	if ((await store.write(key, encode(print), JSON_TYPE, { kind: 'if-absent' })) === 'written') {
		return { status: 'frozen', print };
	}
	// Another run froze it first. Its print may not be readable yet; give it a few reads.
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const winner = await readJson(store, indicativePrintSchema, key);
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
	return readJson(store, indicativePrintSchema, keys.indicative(release.parameters.version, label));
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
