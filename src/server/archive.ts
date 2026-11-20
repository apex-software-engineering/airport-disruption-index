/**
 * The archive: where receipts, raw bodies, day indexes and prints live in the object store, and
 * the rules for writing them. Everything read back is schema-validated; a stored object that
 * fails validation is corruption and throws rather than being skipped.
 */
import type { z } from 'zod';

import { sha256Hex } from '@/lib/index/json';
import { METHODOLOGY } from '@/lib/index/methodology';
import { buildPrint, historyEntryOf } from '@/lib/index/print';
import { receiptHashMatches, summarizeReceipt } from '@/lib/index/round';
import {
	dayIndexSchema,
	historyIndexSchema,
	printSchema,
	receiptSchema,
	type DailyPrint,
	type DayIndex,
	type HistoryIndex,
	type RoundReceipt,
	type RoundSummary,
} from '@/lib/index/schemas';
import {
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
};

function dateOf(id: RoundId): UtcDate {
	const parsed = parseRoundId(id);
	if (parsed === null) throw new Error(`invalid round id ${id}`);
	return parsed.date;
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
	return parsed.slotStart.getTime() + METHODOLOGY.slotMinutes * 60_000 + WRITE_WINDOW_AFTER_SLOT_MS;
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
async function readReceipts(
	store: ObjectStore,
	date: UtcDate,
	ids: readonly RoundId[],
	unreadable: 'throw' | 'skip',
): Promise<RoundReceipt[]> {
	const receipts: RoundReceipt[] = [];
	for (let i = 0; i < ids.length; i += READ_CONCURRENCY) {
		const batch = ids.slice(i, i + READ_CONCURRENCY).map(async (id) => {
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
		for (const receipt of await Promise.all(batch)) if (receipt !== null) receipts.push(receipt);
	}
	return receipts;
}

/** Every receipt stored for `date`, each verified against its own hash. */
export async function readDayReceipts(store: ObjectStore, date: UtcDate): Promise<RoundReceipt[]> {
	return readReceipts(store, date, await listReceiptIds(store, date), 'throw');
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

export type SettleOutcome = { status: 'settled' | 'already_settled'; print: DailyPrint };

/**
 * Builds and stores revision 1 of a day's print from its receipts, and rebuilds the day index
 * from those same receipts. Never overwrites a print. Every path ends by pointing the history
 * index at the day's latest revision.
 */
export async function settleDay(store: ObjectStore, date: UtcDate): Promise<SettleOutcome> {
	const settled = (await readPrints(store, date)).at(-1);
	if (settled !== undefined) {
		await updateHistory(store, settled);
		return { status: 'already_settled', print: settled };
	}
	const receipts = await readDayReceipts(store, date);
	await syncDayIndex(store, date, { kind: 'settle', receipts });
	const print = buildPrint(date, receipts.map(summarizeReceipt), { revision: 1 });
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
