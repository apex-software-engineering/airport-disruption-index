import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { collectedReceipt } from '@/test/receipts';
import { publishBy, settlementDay, settlesAt } from '@/lib/index/calendar';
import { readPrints, recordRound } from '@/server/archive';
import { FileStore } from '@/server/storage';

import { GET, maxDuration } from './route';

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

const settledSchema = z.object({
	status: z.enum(['settled', 'already_settled']),
	date: z.string(),
	result: z.string(),
	printHash: z.string(),
});

async function settleAt(at: string): Promise<Response> {
	vi.setSystemTime(new Date(at));
	return GET(
		new Request('http://test/api/cron/settle', { headers: { authorization: `Bearer ${SECRET}` } }),
	);
}

async function settledAt(at: string): Promise<z.infer<typeof settledSchema>> {
	const response = await settleAt(at);
	expect(response.status, at).toBe(200);
	return settledSchema.parse(await response.json());
}

const cronSchema = z.object({
	crons: z.array(z.object({ path: z.string(), schedule: z.string() })),
});

/** Minutes after midnight UTC for a daily `M H * * *` schedule. */
function dailyMinute(schedule: string): number {
	const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule);
	if (match === null) throw new Error(`settle schedule ${schedule} is not a daily time`);
	return Number(match[2]) * 60 + Number(match[1]);
}

describe('settle schedule', () => {
	const settleRuns = cronSchema
		.parse(JSON.parse(readFileSync('vercel.json', 'utf8')))
		.crons.filter((cron) => cron.path === '/api/cron/settle')
		.map((cron) => dailyMinute(cron.schedule));

	it('runs at the cutoff and retries at least twice, each run ending before the deadline', () => {
		const dayEnd = Date.parse(`${DAY}T00:00:00Z`) + 86_400_000;
		const cutoffMinute = (settlesAt(settlementDay(DAY).window).getTime() - dayEnd) / 60_000;
		const deadlineMinute = (publishBy(settlementDay(DAY).window).getTime() - dayEnd) / 60_000;
		expect(settleRuns).toContain(cutoffMinute);
		expect(settleRuns.length).toBeGreaterThanOrEqual(3);
		for (const minute of settleRuns) {
			expect(minute).toBeGreaterThanOrEqual(cutoffMinute);
			expect(minute + maxDuration / 60).toBeLessThanOrEqual(deadlineMinute);
		}
	});
});

describe('settle route', () => {
	it('refuses before the cutoff, settles at it, and makes each retry a no-op', async () => {
		const receipt = collectedReceipt({
			fetchedAt: new Date(`${DAY}T20:45:03Z`),
			sourceUrl: 'https://nasstatus.faa.gov/api/airport-status-information',
			outcome: { kind: 'network_error', detail: 'ECONNRESET' },
		});
		await recordRound(new FileStore(root), receipt, null, new Date(`${DAY}T20:45:04Z`));

		expect((await settleAt('2026-11-18T00:29:59Z')).status).toBe(409);
		const first = await settledAt('2026-11-18T00:30:00Z');
		expect(first).toMatchObject({ status: 'settled', date: DAY, result: 'suspended' });
		for (const retry of ['2026-11-18T00:45:00Z', '2026-11-18T01:00:00Z']) {
			expect(await settledAt(retry)).toEqual({ ...first, status: 'already_settled' });
		}
		expect(await readPrints(new FileStore(root), DAY)).toHaveLength(1);
	});

	it('refuses a day before the first release instead of failing', async () => {
		vi.setSystemTime(new Date('2026-11-21T00:30:00Z'));
		const response = await GET(
			new Request('http://test/api/cron/settle?date=2026-10-01', {
				headers: { authorization: `Bearer ${SECRET}` },
			}),
		);
		expect(response.status).toBe(400);
	});
});
