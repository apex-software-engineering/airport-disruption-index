import { describe, expect, it } from 'vitest';

import { METHODOLOGY_V1, METHODOLOGY_V2, release } from '@/lib/index/releases';

import { noticeHeadline, readBackNotice, readbackSchema } from './notice-readback';
import type { Get } from './reproduce';

const V2 = release(METHODOLOGY_V2, '2027-01-01', { noticePublishedAt: '2026-11-28T00:00:00.000Z' });
const COMMIT = 'a'.repeat(40);
const RUN = { id: 42, startedAt: new Date('2026-11-28T15:00:00Z') };
const SITE = 'https://site.test';

/** The incidents page as the site renders it: the headline split across markup. */
const SHOWN = `<li><strong>2026-11-28: methodology v2.0.0 announced,
	effective ET day <time>2027-01-01</time>.</strong></li>`;

function site(pages: {
	incidents?: string;
	upcoming?: { version: string; parameterHash: string } | null;
	dates?: [string, string];
}): Get {
	const [incidentsDate, methodologyDate] = pages.dates ?? [
		'Sat, 28 Nov 2026 15:00:05 GMT',
		'Sat, 28 Nov 2026 15:00:06 GMT',
	];
	return async (url) => {
		const headers = { 'X-Deployed-Commit': COMMIT };
		if (url === `${SITE}/incidents`) {
			return new Response(pages.incidents ?? '<p>no notice</p>', {
				headers: { ...headers, Date: incidentsDate },
			});
		}
		if (url === `${SITE}/api/v1/methodology`) {
			return Response.json(
				{ version: '1.0.0', upcoming: pages.upcoming ?? null },
				{ headers: { ...headers, Date: methodologyDate } },
			);
		}
		return new Response('not found', { status: 404, headers: { Date: incidentsDate } });
	};
}

const upcoming = { version: '2.0.0', parameterHash: V2.parameterHash };

describe('the notice readback', () => {
	it('names the release, its version and its first ET day', () => {
		expect(noticeHeadline(V2)).toBe('methodology v2.0.0 announced, effective ET day 2027-01-01');
		const v1 = release(METHODOLOGY_V1, '2026-11-17');
		expect(() => noticeHeadline(v1)).toThrow('1.0.0 has UTC days');
	});

	it('writes nothing until both the incidents entry and the upcoming block show it', async () => {
		expect(await readBackNotice(SITE, V2, RUN, site({ upcoming }))).toEqual({
			kind: 'not_public',
			reasons: [`${SITE}/incidents does not show "${noticeHeadline(V2)}"`],
		});
		expect(await readBackNotice(SITE, V2, RUN, site({ incidents: SHOWN }))).toEqual({
			kind: 'not_public',
			reasons: [`${SITE}/api/v1/methodology has no upcoming block for 2.0.0`],
		});
	});

	it('records N as the latest of the Date headers and the run start, with each body hashed', async () => {
		const readback = await readBackNotice(SITE, V2, RUN, site({ incidents: SHOWN, upcoming }));
		if (readback.kind !== 'recorded') throw new Error('expected a record');
		expect(readbackSchema.parse(readback.record)).toEqual(readback.record);
		expect(readback.record).toMatchObject({
			schema: 'adi.notice-readback/1',
			methodologyVersion: '2.0.0',
			parameterHash: V2.parameterHash,
			run: { id: 42, startedAt: '2026-11-28T15:00:00.000Z' },
			responses: [
				{ url: `${SITE}/incidents`, date: 'Sat, 28 Nov 2026 15:00:05 GMT', deployedCommit: COMMIT },
				{ url: `${SITE}/api/v1/methodology`, date: 'Sat, 28 Nov 2026 15:00:06 GMT' },
			],
			noticeAt: '2026-11-28T15:00:06.000Z',
		});
		// A server clock behind the run's start never moves N earlier than the run.
		const behind = await readBackNotice(
			SITE,
			V2,
			RUN,
			site({
				incidents: SHOWN,
				upcoming,
				dates: ['Sat, 28 Nov 2026 14:00:00 GMT', 'Sat, 28 Nov 2026 14:00:01 GMT'],
			}),
		);
		expect(behind).toMatchObject({ record: { noticeAt: '2026-11-28T15:00:00.000Z' } });
	});

	it('fails, never records, when the site states the release under another hash', async () => {
		const wrong = { version: '2.0.0', parameterHash: 'f'.repeat(64) };
		await expect(
			readBackNotice(SITE, V2, RUN, site({ incidents: SHOWN, upcoming: wrong })),
		).rejects.toThrow(`with parameter hash ${'f'.repeat(64)}, not ${V2.parameterHash}`);
	});
});
