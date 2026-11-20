import { expect, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';

import { receiptSchema } from '@/lib/index/schemas';

const methodologySchema = z.object({
	version: z.string().regex(/^\d+\.\d+\.\d+$/),
	parameterHash: z.string().regex(/^[0-9a-f]{64}$/),
	parameterHashAlgorithm: z.string(),
	parameters: z.record(z.string(), z.unknown()),
});

/** The keys a client of /current relies on; the full shape is the server read model. */
const currentSchema = z.object({
	date: z.string(),
	asOf: z.iso.datetime(),
	status: z.literal('provisional'),
	settlesAt: z.iso.datetime(),
	methodologyVersion: z.string(),
	parameterHash: z.string(),
	value: z.number().int().nonnegative(),
	groundStopValue: z.number().int().nonnegative(),
	airports: z.array(z.object({ airport: z.string() })),
	hourly: z.array(z.object({ hourStart: z.iso.datetime() })).length(24),
	coverage: z.object({ validRounds: z.number(), elapsedSlots: z.number() }),
	latestSlot: z.unknown(),
	lastRound: z
		.object({ roundId: z.string(), fetchedAt: z.iso.datetime(), url: z.string() })
		.nullable(),
});

/** The collector runs every 5 minutes; 20 minutes allows for a late cron and the edge cache. */
const MAX_ROUND_AGE_MS = 20 * 60_000;

async function getJson(request: APIRequestContext, url: string): Promise<unknown> {
	const response = await request.get(url);
	expect(response.status(), `${url} status`).toBe(200);
	expect(response.headers()['content-type'], `${url} content type`).toContain('application/json');
	return response.json();
}

test('/api/v1/methodology returns the parameters and their hash', async ({ request }) => {
	methodologySchema.parse(await getJson(request, '/api/v1/methodology'));
});

test('/api/v1/current links a recent round’s receipt', async ({ request }) => {
	const current = currentSchema.parse(await getJson(request, '/api/v1/current'));
	expect(current.lastRound, 'no round has been recorded today').not.toBeNull();
	if (current.lastRound === null) return;
	const age = Date.now() - Date.parse(current.lastRound.fetchedAt);
	expect(
		age,
		`last round ${current.lastRound.roundId} is stale: is the collector running?`,
	).toBeLessThan(MAX_ROUND_AGE_MS);

	const receipt = receiptSchema.parse(await getJson(request, current.lastRound.url));
	expect(receipt.roundId).toBe(current.lastRound.roundId);
	expect(receipt.parameterHash).toBe(current.parameterHash);
});
