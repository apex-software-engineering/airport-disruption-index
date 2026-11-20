/**
 * The archive: where receipts, raw bodies, day indexes and prints live in the object store, and
 * the rules for writing them. Everything read back is schema-validated; a stored object that
 * fails validation is corruption and throws rather than being skipped.
 */
import type { z } from 'zod';

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
import { parseRoundId, type RoundId, type UtcDate } from '@/lib/index/time';

import type { ObjectStore, StoredObject, WriteCondition } from './storage';

const JSON_TYPE = 'application/json';
const MAX_CONDITIONAL_ATTEMPTS = 5;

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

export type RecordOutcome = 'recorded' | 'superseded_invalid' | 'duplicate';
/** `receipt` is the one the archive holds afterwards, which for a duplicate is the earlier one. */
export type RecordResult = { outcome: RecordOutcome; receipt: RoundReceipt };

/**
 * Stores a round. The first valid round in a slot is final. An invalid round stands until a
 * valid one arrives in the same slot, which replaces it; any other second round is a duplicate
 * and is dropped.
 */
export async function recordRound(
	store: ObjectStore,
	receipt: RoundReceipt,
	body: Uint8Array | null,
): Promise<RecordResult> {
	const date = dateOf(receipt.roundId);
	const key = keys.receipt(date, receipt.roundId);
	const stored = await store.read(key);
	const existing = stored === null ? null : decode(receiptSchema, key, stored);
	if (
		existing !== null &&
		(existing.observation.status === 'valid' || receipt.observation.status === 'invalid')
	) {
		return { outcome: 'duplicate', receipt: existing };
	}
	const condition: WriteCondition =
		stored === null ? { kind: 'if-absent' } : { kind: 'if-version', version: stored.version };
	if (body !== null && receipt.rawSha256 !== null) {
		// An identical body may already be there from an earlier attempt; either way it is the same bytes.
		const rawKey = keys.raw(date, receipt.roundId, receipt.rawSha256);
		await store.write(rawKey, body, 'application/octet-stream', { kind: 'if-absent' });
	}
	const written = await store.write(key, encode(receipt), JSON_TYPE, condition);
	if (written === 'conflict') {
		const winner = await readReceipt(store, receipt.roundId);
		if (winner === null)
			throw new Error(`receipt ${receipt.roundId} conflicted but cannot be read`);
		return { outcome: 'duplicate', receipt: winner };
	}
	await updateDayIndex(store, date, summarizeReceipt(receipt));
	return { outcome: existing === null ? 'recorded' : 'superseded_invalid', receipt };
}

function emptyDayIndex(date: UtcDate): DayIndex {
	return { schema: 'adi.day-index/1', date, rounds: [] };
}

/** The day index: one summary per stored round, so the running value needs a single read. */
export async function readDayIndex(store: ObjectStore, date: UtcDate): Promise<DayIndex> {
	return (await readJson(store, dayIndexSchema, keys.dayIndex(date))) ?? emptyDayIndex(date);
}

async function updateDayIndex(
	store: ObjectStore,
	date: UtcDate,
	summary: RoundSummary,
): Promise<void> {
	await updateJson(store, dayIndexSchema, keys.dayIndex(date), emptyDayIndex(date), (index) => ({
		...index,
		rounds: [...index.rounds.filter((r) => r.roundId !== summary.roundId), summary].sort((x, y) =>
			x.roundId.localeCompare(y.roundId),
		),
	}));
}

/** Read-modify-write with optimistic concurrency on the object's version. */
async function updateJson<T>(
	store: ObjectStore,
	schema: z.ZodType<T>,
	key: string,
	empty: T,
	change: (current: T) => T,
): Promise<void> {
	for (let attempt = 0; attempt < MAX_CONDITIONAL_ATTEMPTS; attempt += 1) {
		const object = await store.read(key);
		const current = object === null ? empty : decode(schema, key, object);
		const condition: WriteCondition =
			object === null ? { kind: 'if-absent' } : { kind: 'if-version', version: object.version };
		if ((await store.write(key, encode(change(current)), JSON_TYPE, condition)) === 'written')
			return;
	}
	throw new Error(`${key}: gave up after ${MAX_CONDITIONAL_ATTEMPTS} conflicting writes`);
}

/** Every receipt stored for `date`, each verified against its own hash. */
export async function readDayReceipts(store: ObjectStore, date: UtcDate): Promise<RoundReceipt[]> {
	const receiptKeys = (await store.list(keys.roundsOf(date))).filter((key) =>
		key.endsWith('.json'),
	);
	const receipts = await Promise.all(
		receiptKeys.map(async (key) => {
			const receipt = await readJson(store, receiptSchema, key);
			if (receipt === null) throw new Error(`receipt ${key} disappeared while settling`);
			if (!receiptHashMatches(receipt))
				throw new Error(`receipt ${key} does not match its receiptHash`);
			return receipt;
		}),
	);
	return receipts;
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

/** Builds and stores revision 1 of a day's print from its receipts. Never overwrites a print. */
export async function settleDay(store: ObjectStore, date: UtcDate): Promise<SettleOutcome> {
	const [existing] = await readPrints(store, date);
	if (existing !== undefined) return { status: 'already_settled', print: existing };
	const receipts = await readDayReceipts(store, date);
	const print = buildPrint(date, receipts.map(summarizeReceipt), { revision: 1 });
	const written = await store.write(keys.print(date, 1), encode(print), JSON_TYPE, {
		kind: 'if-absent',
	});
	if (written === 'conflict') {
		const [winner] = await readPrints(store, date);
		if (winner === undefined) throw new Error(`print ${date} r1 conflicted but cannot be read`);
		return { status: 'already_settled', print: winner };
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
	await updateJson(store, historyIndexSchema, keys.history(), EMPTY_HISTORY, (history) => ({
		...history,
		days: [...history.days.filter((d) => d.date !== entry.date), entry].sort((x, y) =>
			x.date.localeCompare(y.date),
		),
	}));
}
