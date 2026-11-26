/**
 * An indicative day the API does not serve, judged against the real registry: the v2 notice, and
 * so the series, is published at 2026-11-29T00:00Z, and the days before it are backfilled by hand.
 */
import { describe, expect, it } from 'vitest';

import { reproduceIndicative, type Get } from './reproduce';

/** The API's 404 for a day not frozen yet, stating when it freezes. */
const notFrozen =
	(freezesAt: string): Get =>
	async () =>
		Response.json({ status: 'pending', freezesAt }, { status: 404 });

const at = (date: string, freezesAt: string, instant: string) =>
	reproduceIndicative(date, 'http://test', notFrozen(freezesAt), () => new Date(instant));

describe('an indicative day not served yet (Sol #41 r2, finding 4; Opus finding 1)', () => {
	it('leaves a day frozen before publication its backfill allowance: 12 hours from the instant', async () => {
		// ET 2026-11-22 froze (on paper) days before the series was published.
		expect(
			await at('2026-11-22', '2026-11-23T05:30:00.000Z', '2026-11-29T01:50:00Z'),
		).toMatchObject({
			kind: 'cannot_verify',
		});
		expect(
			await at('2026-11-22', '2026-11-23T05:30:00.000Z', '2026-11-29T11:59:59Z'),
		).toMatchObject({
			kind: 'cannot_verify',
		});
		expect(
			await at('2026-11-22', '2026-11-23T05:30:00.000Z', '2026-11-29T12:00:00Z'),
		).toMatchObject({
			kind: 'mismatch',
			problems: [
				'indicative day 2026-11-22 is not served at 2026-11-29T12:00:00.000Z, though it was due by 2026-11-29T12:00:00.000Z',
			],
		});
	});

	it('holds a day frozen after the allowance to its own freeze time plus 2 hours', async () => {
		expect(
			await at('2026-11-30', '2026-12-01T05:30:00.000Z', '2026-12-01T07:29:59Z'),
		).toMatchObject({
			kind: 'cannot_verify',
		});
		expect(
			await at('2026-11-30', '2026-12-01T05:30:00.000Z', '2026-12-01T07:30:00Z'),
		).toMatchObject({
			kind: 'mismatch',
		});
	});
});
