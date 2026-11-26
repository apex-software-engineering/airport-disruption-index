import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { collectedReceipt } from '@/test/receipts';
import { dayWindow, publishBy, settlesAt } from '@/lib/index/calendar';
import { METHODOLOGY_V2, RELEASES, release } from '@/lib/index/releases';
import { readHistory, readPrints, recordRound } from '@/server/archive';
import { FileStore } from '@/server/storage';

import { ATTEMPT_DEADLINE_MS, GET, maxDuration } from './route';

const SECRET = 'test-cron-secret';
const DAY = '2026-11-17';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-settle-'));
	vi.stubEnv('ADI_DATA_DIR', root);
	vi.stubEnv('CRON_SECRET', SECRET);
	vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const dayOutcome = z.object({
	date: z.string(),
	status: z.enum(['settled', 'already_settled', 'blocked', 'failed']),
	result: z.string().optional(),
	printHash: z.string().optional(),
	reason: z.string().optional(),
});
const runSchema = z.object({
	status: z.enum(['ran', 'nothing_due']),
	settled: z.array(dayOutcome),
	indicative: z.array(z.unknown()),
});

async function runAt(at: string, query = ''): Promise<Response> {
	vi.setSystemTime(new Date(at));
	return GET(
		new Request(`http://test/api/cron/settle${query}`, {
			headers: { authorization: `Bearer ${SECRET}` },
		}),
	);
}

async function defaultRunAt(at: string, expectedStatus = 200) {
	const response = await runAt(at);
	expect(response.status, at).toBe(expectedStatus);
	return runSchema.parse(await response.json());
}

/** A round in `date`'s partition, stored at fetch time. */
async function recordAt(fetchedAt: string) {
	const receipt = collectedReceipt({
		fetchedAt: new Date(fetchedAt),
		sourceUrl: 'https://nasstatus.faa.gov/api/airport-status-information',
		outcome: { kind: 'network_error', detail: 'ECONNRESET' },
	});
	await recordRound(new FileStore(root), receipt, null, new Date(Date.parse(fetchedAt) + 1000));
}

const cronSchema = z.object({
	crons: z.array(z.object({ path: z.string(), schedule: z.string() })),
});

/** Every run of a daily `M[,M…] H[,H…] * * *` schedule, in minutes after midnight UTC. */
function runMinutes(schedule: string): number[] {
	const match = /^([\d,]+) ([\d,]+) \* \* \*$/.exec(schedule);
	if (match?.[1] === undefined || match[2] === undefined)
		throw new Error(`settle schedule ${schedule} is not a daily list of times`);
	const minutes = match[1].split(',').map(Number);
	return match[2].split(',').flatMap((hour) => minutes.map((minute) => Number(hour) * 60 + minute));
}

describe('settle schedule', () => {
	const settleRuns = cronSchema
		.parse(JSON.parse(readFileSync('vercel.json', 'utf8')))
		.crons.filter((cron) => cron.path === '/api/cron/settle')
		.flatMap((cron) => runMinutes(cron.schedule))
		.sort((x, y) => x - y);
	const v1 = RELEASES[0];
	if (v1 === undefined) throw new Error('the registry lists v1');
	const v2 = release(METHODOLOGY_V2, '2027-01-01', { announcedAt: '2026-11-25T15:00:00.000Z' });

	it.each([
		['a v1 UTC day', v1, DAY],
		['an ET day in EST', v2, '2027-01-15'],
		['an ET day in EDT', v2, '2027-07-15'],
		['the spring-forward ET day (23 h)', v2, '2027-03-14'],
		['the fall-back ET day (25 h)', v2, '2027-11-07'],
	])(
		'settles %s at its cutoff and retries twice, each run ending by publishBy',
		(_, owner, label) => {
			const window = dayWindow(owner, label);
			const midnight = Date.parse(`${window.end.toISOString().slice(0, 10)}T00:00:00Z`);
			const minuteOf = (instant: Date) => (instant.getTime() - midnight) / 60_000;
			const cutoff = minuteOf(settlesAt(window));
			const deadline = minuteOf(publishBy(window));
			const runs = settleRuns.filter(
				(minute) => minute >= cutoff && minute + maxDuration / 60 <= deadline,
			);
			expect(runs[0]).toBe(cutoff);
			expect(runs.length).toBeGreaterThanOrEqual(3);
		},
	);
});

describe('settle route', () => {
	it('answers nothing_due when no day’s cutoff passed in the last 48 hours', async () => {
		expect(await defaultRunAt('2026-11-18T00:29:59Z')).toEqual({
			status: 'nothing_due',
			settled: [],
			indicative: [],
		});
	});

	it('refuses a named day before its cutoff', async () => {
		expect((await runAt('2026-11-18T00:29:59Z', `?date=${DAY}`)).status).toBe(409);
	});

	it('settles at the cutoff, and makes each retry a no-op', async () => {
		await recordAt(`${DAY}T20:45:03Z`);
		const first = await defaultRunAt('2026-11-18T00:30:00Z');
		expect(first.settled).toEqual([
			expect.objectContaining({ date: DAY, status: 'settled', result: 'suspended' }),
		]);
		for (const retry of ['2026-11-18T00:45:00Z', '2026-11-18T01:00:00Z']) {
			expect((await defaultRunAt(retry)).settled).toEqual([
				{ ...first.settled[0], status: 'already_settled' },
			]);
		}
		expect(await readPrints(new FileStore(root), DAY)).toHaveLength(1);
	});

	it('attempts each due day independently: one that fails never stops another', async () => {
		await recordAt('2026-11-18T10:00:03Z');
		// An unreadable receipt in 2026-11-17's partition stops that day's settlement only.
		await recordAt(`${DAY}T10:00:03Z`);
		await writeFile(path.join(root, `rounds/${DAY}/${DAY}T10:00Z.json`), '{');
		const run = await defaultRunAt('2026-11-19T00:30:00Z', 500);
		expect(run.settled).toEqual([
			expect.objectContaining({ date: DAY, status: 'failed' }),
			expect.objectContaining({ date: '2026-11-18', status: 'settled' }),
		]);
	});

	it('gives each day its own deadline, so a stalled one never holds up another (Sol 3b r1, finding 3)', async () => {
		await recordAt('2026-11-18T10:00:03Z');
		await recordAt(`${DAY}T10:00:03Z`);
		// Every read of 2026-11-17's receipts hangs, as a stalled storage request would.
		const read = FileStore.prototype.read;
		const stalled = vi.spyOn(FileStore.prototype, 'read').mockImplementation(function (
			this: FileStore,
			key,
		) {
			return key.startsWith(`rounds/${DAY}/`) ? new Promise(() => {}) : read.call(this, key);
		});
		// 2026-11-18's settlement ends by writing the history; the deadline passes only after that.
		let historyWritten = () => {};
		const otherSettled = new Promise<void>((resolve) => (historyWritten = resolve));
		const write = FileStore.prototype.write;
		const watched = vi.spyOn(FileStore.prototype, 'write').mockImplementation(async function (
			this: FileStore,
			...args
		) {
			const result = await write.apply(this, args);
			if (args[0] === 'prints/history.json') historyWritten();
			return result;
		});
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		vi.setSystemTime(new Date('2026-11-19T00:30:00Z'));
		const pending = GET(
			new Request('http://test/api/cron/settle', {
				headers: { authorization: `Bearer ${SECRET}` },
			}),
		);
		await otherSettled;
		for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(ATTEMPT_DEADLINE_MS);
		const response = await pending;
		stalled.mockRestore();
		watched.mockRestore();
		expect(response.status).toBe(500);
		expect(runSchema.parse(await response.json()).settled).toEqual([
			expect.objectContaining({
				date: DAY,
				status: 'failed',
				reason: expect.stringMatching(/did not finish within/),
			}),
			expect.objectContaining({ date: '2026-11-18', status: 'settled' }),
		]);
	});

	it('repoints the history at the settled print on already_settled', async () => {
		await defaultRunAt('2026-11-18T00:30:00Z');
		await rm(path.join(root, 'prints/history.json'));
		expect((await defaultRunAt('2026-11-18T00:45:00Z')).settled).toEqual([
			expect.objectContaining({ date: DAY, status: 'already_settled' }),
		]);
		expect((await readHistory(new FileStore(root), DAY, DAY)).days).toEqual([
			expect.objectContaining({ date: DAY, revision: 1 }),
		]);
	});

	it('settles a named day at any age, past the 48-hour default', async () => {
		expect((await defaultRunAt('2026-11-25T00:30:00Z')).settled.map((d) => d.date)).toEqual([
			'2026-11-23',
			'2026-11-24',
		]);
		const named = await runAt('2026-11-25T00:30:00Z', `?date=${DAY}`);
		expect(named.status).toBe(200);
		expect(await named.json()).toMatchObject({ date: DAY, status: 'settled', indicative: [] });
	});

	it('refuses a day before the first release instead of failing', async () => {
		expect((await runAt('2026-11-21T00:30:00Z', '?date=2026-10-01')).status).toBe(400);
	});
});
