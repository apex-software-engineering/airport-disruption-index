import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectedReceipt } from '@/test/receipts';
import { feedFixture } from '@/test/fixtures';
import { DAY, validRound } from '@/test/rounds';

import { buildPrint } from '@/lib/index/print';

import {
	readDayIndex,
	readHistory,
	readPrints,
	readRaw,
	readReceipt,
	recordRound,
	settleDay,
} from './archive';
import { collectRound, type FeedFetcher } from './collector';
import { FileStore, type WriteCondition } from './storage';
import { currentView, dayView, historyView, roundCache } from './views';

let root: string;
let store: FileStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-'));
	store = new FileStore(root);
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** A fetcher answering with `fixture` (Update_Time 20:43:54Z) at `fetchedAt`. */
function fixtureAt(
	fetchedAt: string,
	fixture = 'synthetic-gs-gdp.xml',
	httpStatus = 200,
): FeedFetcher {
	return async () => ({
		fetchedAt: new Date(fetchedAt),
		outcome: { kind: 'response', httpStatus, body: feedFixture(fixture) },
	});
}

/** Collects with the archive's clock one second after the fetch. */
function collect(fetchedAt: string, fixture?: string, httpStatus?: number) {
	return collectRound(
		store,
		fixtureAt(fetchedAt, fixture, httpStatus),
		() => new Date(Date.parse(fetchedAt) + 1000),
	);
}

describe('collectRound', () => {
	it('archives the receipt, the raw body and a day index entry', async () => {
		const { outcome, receipt } = await collect('2026-11-17T20:45:03Z');
		expect(outcome).toBe('recorded');
		expect(await readReceipt(store, '2026-11-17T20:45Z')).toEqual(receipt);
		expect(await readRaw(store, receipt)).toEqual(feedFixture('synthetic-gs-gdp.xml'));
		const index = await readDayIndex(store, '2026-11-17');
		expect(index.rounds.map((r) => r.roundId)).toEqual(['2026-11-17T20:45Z']);
	});

	it('is idempotent within a slot: the first valid round wins', async () => {
		const first = await collect('2026-11-17T20:45:03Z');
		const second = await collect('2026-11-17T20:46:00Z', 'live-2026-11-17T20-43-56Z.xml');
		expect(second.outcome).toBe('duplicate');
		expect(second.receipt).toEqual(first.receipt);
		expect((await readReceipt(store, '2026-11-17T20:45Z'))?.receiptHash).toBe(
			first.receipt.receiptHash,
		);
		expect((await readDayIndex(store, '2026-11-17')).rounds).toHaveLength(1);
	});

	it('lets a valid round replace an invalid one in the same slot, but not the reverse', async () => {
		expect((await collect('2026-11-17T20:45:01Z', 'synthetic-gs-gdp.xml', 503)).outcome).toBe(
			'recorded',
		);
		expect((await collect('2026-11-17T20:45:30Z', 'synthetic-gs-gdp.xml', 502)).outcome).toBe(
			'duplicate',
		);
		expect((await readReceipt(store, '2026-11-17T20:45Z'))?.httpStatus).toBe(503);
		expect((await collect('2026-11-17T20:46:00Z')).outcome).toBe('superseded_invalid');
		const index = await readDayIndex(store, '2026-11-17');
		expect(index.rounds.map((r) => r.observation.status)).toEqual(['valid']);
	});

	it('records a network failure without a raw body', async () => {
		const failing: FeedFetcher = async () => ({
			fetchedAt: new Date('2026-11-17T20:50:02Z'),
			outcome: { kind: 'network_error', detail: 'TimeoutError: timed out' },
		});
		const { receipt } = await collectRound(store, failing, () => new Date('2026-11-17T20:50:03Z'));
		expect(receipt.observation).toMatchObject({ status: 'invalid', reason: 'network_error' });
		expect(await readRaw(store, receipt)).toBeNull();
	});
});

describe('views and settlement', () => {
	it('serves the running value and settles a day once', async () => {
		await collect('2026-11-17T20:45:03Z');
		await collect('2026-11-17T20:50:03Z');
		const current = await currentView(store, new Date('2026-11-17T20:56:00Z'));
		// LGA (GS+GDP) and SFO (GDP) in the 20:45 and 20:50 slots; 20:55 has not ended, so it is pending.
		expect(current).toMatchObject({
			date: '2026-11-17',
			status: 'provisional',
			value: 20,
			groundStopValue: 10,
		});
		expect(current.lastRound).toMatchObject({
			roundId: '2026-11-17T20:50Z',
			url: '/api/v1/rounds/2026-11-17T20:50Z',
		});
		// The open slot is 20:55: no round yet, so pending.
		expect(current.latestSlot).toEqual({ status: 'pending' });
		await collect('2026-11-17T20:55:03Z');
		expect((await currentView(store, new Date('2026-11-17T20:56:00Z'))).latestSlot).toMatchObject({
			status: 'observed',
			roundId: '2026-11-17T20:55Z',
		});

		expect(current).toMatchObject({
			settlesAt: '2026-11-18T00:30:00.000Z',
			publishBy: '2026-11-18T01:30:00.000Z',
			foreignMethodologies: [],
			unrecognizedLists: [],
		});
		expect(await dayView(store, '2026-11-17')).toEqual({
			date: '2026-11-17',
			status: 'unsettled',
			settlesAt: '2026-11-18T00:30:00.000Z',
			publishBy: '2026-11-18T01:30:00.000Z',
		});
		const settled = await settleDay(store, '2026-11-17');
		expect(settled.status).toBe('settled');
		expect(settled.print.result).toEqual({
			status: 'suspended',
			reason: 'coverage 3/288 valid rounds is below 80%',
		});
		expect(settled.print.rounds).toHaveLength(3);
		const again = await settleDay(store, '2026-11-17');
		expect(again).toEqual({ status: 'already_settled', print: settled.print });
		expect(await readPrints(store, '2026-11-17')).toHaveLength(1);
		expect(await historyView(store, '2026-11-01', '2026-11-30')).toMatchObject({
			days: [
				{ date: '2026-11-17', status: 'suspended', value: null, url: '/api/v1/days/2026-11-17' },
			],
		});
	});
});

/** A store where another writer lands an invalid receipt just before our first receipt write. */
class RacingStore extends FileStore {
	private raced = false;
	constructor(
		root: string,
		private readonly racer: () => Promise<void>,
	) {
		super(root);
	}
	override async write(
		key: string,
		body: Uint8Array,
		contentType: string,
		condition: WriteCondition,
	) {
		if (!this.raced && key.endsWith('Z.json')) {
			this.raced = true;
			await this.racer();
		}
		return super.write(key, body, contentType, condition);
	}
}

describe('archive write rules', () => {
	const fetchedAt = new Date('2026-11-17T20:45:03Z');
	const now = new Date('2026-11-17T20:45:04Z');
	const valid = collectedReceipt({
		fetchedAt,
		sourceUrl: 'https://nasstatus.faa.gov/api/airport-status-information',
		outcome: { kind: 'response', httpStatus: 200, body: feedFixture('synthetic-gs-gdp.xml') },
	});
	const invalid = collectedReceipt({
		fetchedAt: new Date('2026-11-17T20:45:01Z'),
		sourceUrl: valid.sourceUrl,
		outcome: { kind: 'network_error', detail: 'ECONNRESET' },
	});

	it('re-applies the rule after losing a conditional write to an invalid receipt', async () => {
		const racing = new RacingStore(root, async () => {
			await recordRound(new FileStore(root), invalid, null, now);
		});
		const result = await recordRound(racing, valid, feedFixture('synthetic-gs-gdp.xml'), now);
		expect(result.outcome).toBe('superseded_invalid');
		expect((await readReceipt(store, valid.roundId))?.receiptHash).toBe(valid.receiptHash);
	});

	it('heals a day index that has drifted from the receipts on a duplicate retry', async () => {
		await recordRound(store, valid, feedFixture('synthetic-gs-gdp.xml'), now);
		const index = await store.read('days/2026-11-17.json');
		if (index === null) throw new Error('no day index');
		const empty = new TextEncoder().encode(
			JSON.stringify({ schema: 'adi.day-index/1', date: '2026-11-17', rounds: [] }),
		);
		await store.write('days/2026-11-17.json', empty, 'application/json', {
			kind: 'if-version',
			version: index.version,
		});
		expect((await recordRound(store, invalid, null, now)).outcome).toBe('duplicate');
		expect((await readDayIndex(store, '2026-11-17')).rounds.map((r) => r.receiptHash)).toEqual([
			valid.receiptHash,
		]);
	});

	it('refuses a receipt that does not describe its body, or a tampered receipt', async () => {
		const other = feedFixture('live-2026-11-17T20-43-56Z.xml');
		await expect(recordRound(store, valid, other, now)).rejects.toThrow(/does not describe/);
		await expect(recordRound(store, valid, null, now)).rejects.toThrow(/does not describe/);
		await expect(
			recordRound(store, { ...valid, rawBytes: 1 }, feedFixture('synthetic-gs-gdp.xml'), now),
		).rejects.toThrow(/receiptHash/);
		expect(await readReceipt(store, valid.roundId)).toBeNull();
	});

	it('refuses a round once its write window has closed', async () => {
		await expect(
			recordRound(store, invalid, null, new Date('2026-11-17T20:51:00Z')),
		).rejects.toThrow(/write window/);
	});

	it('caches valid receipts forever and invalid ones never', () => {
		expect(roundCache(valid)).toMatch(/immutable/);
		expect(roundCache(invalid)).toBe('no-store');
	});

	it('lists once and reads no other receipt when the index is complete and valid', async () => {
		await collect('2026-11-17T20:44:03Z');
		await collect('2026-11-17T20:50:03Z');
		const counting = new CountingStore(root);
		await recordRound(counting, valid, feedFixture('synthetic-gs-gdp.xml'), now);
		expect(counting.lists).toBe(1);
		expect(counting.receiptReads.filter((key) => !key.includes(valid.roundId))).toEqual([]);
		expect((await readDayIndex(store, '2026-11-17')).rounds).toHaveLength(3);
	});

	it('skips an unreadable receipt of another round on collect; settle still refuses it', async () => {
		const garbage = new TextEncoder().encode('not a receipt');
		await store.write('rounds/2026-11-17/2026-11-17T20:40Z.json', garbage, 'application/json', {
			kind: 'if-absent',
		});
		expect((await collect('2026-11-17T20:45:03Z')).outcome).toBe('recorded');
		expect((await collect('2026-11-17T20:50:03Z')).outcome).toBe('recorded');
		expect((await readDayIndex(store, '2026-11-17')).rounds.map((r) => r.roundId)).toEqual([
			'2026-11-17T20:45Z',
			'2026-11-17T20:50Z',
		]);
		await expect(settleDay(store, '2026-11-17')).rejects.toThrow();
	});

	it('heals a supersede whose index patch failed, on the next collect', async () => {
		await collect('2026-11-17T20:45:01Z', 'synthetic-gs-gdp.xml', 503);
		const failing = new FailingIndexStore(root);
		await expect(
			collectRound(
				failing,
				fixtureAt('2026-11-17T20:45:30Z'),
				() => new Date('2026-11-17T20:45:31Z'),
			),
		).rejects.toThrow(/index write failed/);
		expect((await readReceipt(store, '2026-11-17T20:45Z'))?.observation.status).toBe('valid');
		expect((await readDayIndex(store, '2026-11-17')).rounds[0]?.observation.status).toBe('invalid');
		await collect('2026-11-17T20:50:03Z');
		expect(
			(await readDayIndex(store, '2026-11-17')).rounds.map((r) => r.observation.status),
		).toEqual(['valid', 'valid']);
	});

	it('heals a recent failed supersede even behind more than 15 older invalid rounds', async () => {
		// 17 invalid rounds, 19:20Z to 20:40Z.
		for (let minute = 19 * 60 + 20; minute <= 20 * 60 + 40; minute += 5) {
			const slot = Date.parse('2026-11-17T00:00:00Z') + minute * 60_000;
			const failed = collectedReceipt({
				fetchedAt: new Date(slot + 3000),
				sourceUrl: valid.sourceUrl,
				outcome: { kind: 'network_error', detail: 'ECONNRESET' },
			});
			await recordRound(store, failed, null, new Date(slot + 4000));
		}
		await collect('2026-11-17T20:45:01Z', 'synthetic-gs-gdp.xml', 503);
		await expect(
			collectRound(
				new FailingIndexStore(root),
				fixtureAt('2026-11-17T20:45:30Z'),
				() => new Date('2026-11-17T20:45:31Z'),
			),
		).rejects.toThrow(/index write failed/);
		await collect('2026-11-17T20:50:03Z');
		const index = await readDayIndex(store, '2026-11-17');
		expect(index.rounds.find((r) => r.roundId === '2026-11-17T20:45Z')?.observation.status).toBe(
			'valid',
		);
	});

	it('includes its own round when rebuilding a malformed index from a lagging listing', async () => {
		await collect('2026-11-17T20:40:03Z');
		await overwriteDayIndex('not json');
		const lagging = new LaggingListStore(root, '2026-11-17T20:45Z');
		await collectRound(
			lagging,
			fixtureAt('2026-11-17T20:45:03Z'),
			() => new Date('2026-11-17T20:45:04Z'),
		);
		expect((await readDayIndex(store, '2026-11-17')).rounds.map((r) => r.roundId)).toEqual([
			'2026-11-17T20:40Z',
			'2026-11-17T20:45Z',
		]);
	});

	it('heals a round whose index patch was missed, on the next collect in another slot', async () => {
		await collect('2026-11-17T20:40:03Z');
		await overwriteDayIndex(
			JSON.stringify({ schema: 'adi.day-index/1', date: '2026-11-17', rounds: [] }),
		);
		await collect('2026-11-17T20:45:03Z');
		expect((await readDayIndex(store, '2026-11-17')).rounds.map((r) => r.roundId)).toEqual([
			'2026-11-17T20:40Z',
			'2026-11-17T20:45Z',
		]);
	});

	it('rebuilds a malformed day index on collect instead of failing every collect', async () => {
		await collect('2026-11-17T20:40:03Z');
		await overwriteDayIndex('{"schema":"adi.day-index/1","rounds":"broken"');
		expect((await collect('2026-11-17T20:45:03Z')).outcome).toBe('recorded');
		expect((await readDayIndex(store, '2026-11-17')).rounds).toHaveLength(2);
	});

	it('persists the schema-parsed receipt, not extra fields the caller sent', async () => {
		const withExtra = Object.assign({}, valid, { extra: 'not part of a receipt' });
		await recordRound(store, withExtra, feedFixture('synthetic-gs-gdp.xml'), now);
		const stored = await store.read(`rounds/2026-11-17/${valid.roundId}.json`);
		expect(stored && JSON.parse(new TextDecoder().decode(stored.body))).not.toHaveProperty('extra');
	});

	it('refuses a receipt whose round id is not the slot of its fetch time', async () => {
		await expect(
			recordRound(store, { ...invalid, roundId: '2026-11-17T20:50Z' }, null, now),
		).rejects.toThrow(/not in the slot/);
	});
});

/** Counts list() calls. */
class CountingStore extends FileStore {
	lists = 0;
	receiptReads: string[] = [];
	override async list(prefix: string) {
		this.lists += 1;
		return super.list(prefix);
	}
	override async read(key: string) {
		if (key.startsWith('rounds/') && key.endsWith('.json')) this.receiptReads.push(key);
		return super.read(key);
	}
}

/** A store whose day index writes fail, as if the function died after the receipt write. */
class FailingIndexStore extends FileStore {
	override async write(
		key: string,
		body: Uint8Array,
		contentType: string,
		condition: WriteCondition,
	) {
		if (key.startsWith('days/')) throw new Error('index write failed');
		return super.write(key, body, contentType, condition);
	}
}

/** A store whose listing has not caught up with one round's receipt yet. */
class LaggingListStore extends FileStore {
	constructor(
		root: string,
		private readonly hidden: string,
	) {
		super(root);
	}
	override async list(prefix: string) {
		return (await super.list(prefix)).filter((key) => !key.includes(this.hidden));
	}
}

/** Replaces the stored day index with `content`, as a failed or corrupted write would leave it. */
async function overwriteDayIndex(content: string): Promise<void> {
	const index = await store.read('days/2026-11-17.json');
	if (index === null) throw new Error('no day index');
	const body = new TextEncoder().encode(content);
	const written = await store.write('days/2026-11-17.json', body, 'application/json', {
		kind: 'if-version',
		version: index.version,
	});
	if (written !== 'written') throw new Error('could not overwrite the day index');
}

/** A store where print writes always lose and prints never become readable. */
class LostPrintStore extends FileStore {
	override async write(
		key: string,
		body: Uint8Array,
		contentType: string,
		condition: WriteCondition,
	) {
		return key.startsWith('prints/2026-11-17/')
			? 'conflict'
			: super.write(key, body, contentType, condition);
	}
}

/** Fails the first read of any receipt, as a blob read can fail once and then succeed. */
class FlakyReceiptStore extends FileStore {
	private failed = false;

	override async read(key: string) {
		if (!this.failed && key.startsWith('rounds/') && key.endsWith('.json')) {
			this.failed = true;
			throw new Error(`transient read failure for ${key}`);
		}
		return super.read(key);
	}
}

describe('settlement', () => {
	it('rebuilds the day index from receipts, ignoring whatever the old index held', async () => {
		await collect('2026-11-17T20:45:03Z');
		const index = await store.read('days/2026-11-17.json');
		if (index === null) throw new Error('no day index');
		await store.write(
			'days/2026-11-17.json',
			new TextEncoder().encode('not json'),
			'application/json',
			{
				kind: 'if-version',
				version: index.version,
			},
		);
		await settleDay(store, '2026-11-17');
		expect((await readDayIndex(store, '2026-11-17')).rounds).toHaveLength(1);
	});

	it('settles on a retry after a run that could not read a receipt', async () => {
		await collect('2026-11-17T20:45:03Z');
		const flaky = new FlakyReceiptStore(root);
		await expect(settleDay(flaky, '2026-11-17')).rejects.toThrow(/transient/);
		expect(await readPrints(store, '2026-11-17')).toEqual([]);
		const retried = await settleDay(flaky, '2026-11-17');
		expect(retried.status).toBe('settled');
		expect(await settleDay(flaky, '2026-11-17')).toEqual({
			status: 'already_settled',
			print: retried.print,
		});
	});

	it('fails loudly, and does not loop, when a print conflicts but cannot be read', async () => {
		await collect('2026-11-17T20:45:03Z');
		await expect(settleDay(new LostPrintStore(root), '2026-11-17')).rejects.toThrow(
			/could not be read/,
		);
	});
});

describe('unrecognized lists', () => {
	it('flags each unrecognized list seen today in the running value', async () => {
		await collect('2026-11-17T20:45:03Z', 'synthetic-edge-cases.xml');
		await collect('2026-11-17T20:50:03Z', 'synthetic-edge-cases.xml');
		await collect('2026-11-17T20:55:03Z');
		const current = await currentView(store, new Date('2026-11-17T20:56:00Z'));
		expect(current.unrecognizedLists).toEqual([
			{ element: 'Deicing_List', name: 'Deicing', rounds: 2, lastRoundId: '2026-11-17T20:50Z' },
			{ element: null, name: 'Empty block', rounds: 2, lastRoundId: '2026-11-17T20:50Z' },
		]);
	});

	it('counts a round once when it repeats an unrecognized list', async () => {
		const round = validRound(0);
		if (round.observation.status !== 'valid') throw new Error('validRound is valid');
		const deicing = { element: 'Deicing_List', name: 'Deicing' };
		const repeated = {
			...round,
			observation: { ...round.observation, unrecognized: [deicing, deicing] },
		};
		const index = { schema: 'adi.day-index/1', date: DAY, rounds: [repeated] };
		await store.write(
			`days/${DAY}.json`,
			new TextEncoder().encode(JSON.stringify(index)),
			'application/json',
			{
				kind: 'if-absent',
			},
		);
		const current = await currentView(store, new Date(`${DAY}T00:05:30Z`));
		expect(current.unrecognizedLists).toEqual([
			{ ...deicing, rounds: 1, lastRoundId: round.roundId },
		]);
	});

	it('reads a day index written before the field existed as recording none', async () => {
		await collect('2026-11-17T20:45:03Z', 'synthetic-edge-cases.xml');
		const object = await store.read('days/2026-11-17.json');
		if (object === null) throw new Error('no day index');
		const legacy = new TextDecoder()
			.decode(object.body)
			.replaceAll(/,"unrecognized":\[[^\]]*\]/g, '');
		expect(legacy).not.toContain('unrecognized');
		await store.write(
			'days/2026-11-17.json',
			new TextEncoder().encode(legacy),
			'application/json',
			{
				kind: 'if-version',
				version: object.version,
			},
		);
		const current = await currentView(store, new Date('2026-11-17T20:50:30Z'));
		expect(current.unrecognizedLists).toEqual([]);
		expect(current.coverage.validRounds).toBe(1);
	});
});

describe('settlement history', () => {
	it('points history at the latest revision, including on the already-settled path', async () => {
		await collect('2026-11-17T20:45:03Z');
		const first = await settleDay(store, '2026-11-17');
		// A later correction print, written outside settleDay.
		const corrected = buildPrint('2026-11-17', [], {
			revision: 2,
			supersedesPrintHash: first.print.printHash,
			reason: 'test correction',
		});
		await store.write(
			'prints/2026-11-17/r2.json',
			new TextEncoder().encode(JSON.stringify(corrected)),
			'application/json',
			{ kind: 'if-absent' },
		);
		const again = await settleDay(store, '2026-11-17');
		expect(again).toEqual({ status: 'already_settled', print: corrected });
		expect((await readHistory(store)).days).toMatchObject([
			{ date: '2026-11-17', revision: 2, printHash: corrected.printHash },
		]);
		expect(await dayView(store, '2026-11-17')).toMatchObject({
			print: { revision: 2 },
			revisions: [{ revision: 1 }, { revision: 2 }],
		});
	});
});
