import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { METHODOLOGY_V1, METHODOLOGY_V2, RELEASES, release } from '@/lib/index/releases';

import { sha256Hex } from '@/lib/index/json';

import { noticeHeadline, readBackNotice, readbackSchema } from './notice-readback';
import type { Get } from './reproduce';

const V2 = release(METHODOLOGY_V2, '2027-01-01', { noticePublishedAt: '2026-11-28T00:00:00.000Z' });
const COMMIT = 'a'.repeat(40);
const RUN = { id: 42, attempt: 2, startedAt: new Date('2026-11-28T15:00:00Z') };
const SITE = 'https://site.test';
/** The runner's own clock while it reads: just after the run starts. */
const CLOCK = () => new Date('2026-11-28T15:00:05Z');

/** The incidents entry as the site renders it: headline split across markup, then the hash. */
const entry = (headline: string, hash: string) =>
	`<li><strong>${headline}</strong> The parameter hash changes to <code>${hash}</code>.</li>`;
const SHOWN = entry(
	`2026-11-28: methodology v2.0.0 announced,\n\teffective ET day <time>2027-01-01</time>.`,
	V2.parameterHash,
);

function site(pages: {
	incidents?: string;
	upcoming?: { version: string; parameterHash: string } | null;
	dates?: [string, string];
	commit?: string | null;
	redirectedTo?: string;
	incidentsType?: string;
	redirectStatus?: number;
}): Get {
	const [incidentsDate, methodologyDate] = pages.dates ?? [
		'Sat, 28 Nov 2026 15:00:05 GMT',
		'Sat, 28 Nov 2026 15:00:06 GMT',
	];
	return async (url) => {
		const commit = pages.commit === undefined ? COMMIT : pages.commit;
		const headers: Record<string, string> = commit === null ? {} : { 'X-Deployed-Commit': commit };
		if (url === `${SITE}/incidents`) {
			if (pages.redirectStatus !== undefined) {
				return new Response(null, {
					status: pages.redirectStatus,
					headers: { Date: incidentsDate, Location: 'https://elsewhere.test/incidents' },
				});
			}
			const response = new Response(pages.incidents ?? '<p>no notice</p>', {
				headers: {
					...headers,
					Date: incidentsDate,
					'Content-Type': pages.incidentsType ?? 'text/html; charset=utf-8',
				},
			});
			if (pages.redirectedTo !== undefined) {
				Object.defineProperty(response, 'redirected', { value: true });
				Object.defineProperty(response, 'url', { value: pages.redirectedTo });
			}
			return response;
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
		expect(await readBackNotice(SITE, V2, RUN, CLOCK, site({ upcoming }))).toEqual({
			kind: 'not_public',
			reasons: [
				`${SITE}/incidents does not show "${noticeHeadline(V2)}"`,
				`${SITE}/incidents does not show "${V2.parameterHash}"`,
			],
		});
		expect(await readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents: SHOWN }))).toEqual({
			kind: 'not_public',
			reasons: [`${SITE}/api/v1/methodology has no upcoming block for 2.0.0`],
		});
	});

	it('records N as the latest of the Date headers, the run start and its observation, with each body kept and hashed', async () => {
		const readback = await readBackNotice(
			SITE,
			V2,
			RUN,
			CLOCK,
			site({ incidents: SHOWN, upcoming }),
		);
		if (readback.kind !== 'recorded') throw new Error('expected a record');
		expect(readbackSchema.parse(readback.record)).toEqual(readback.record);
		expect(readback.record).toMatchObject({
			schema: 'adi.notice-readback/1',
			methodologyVersion: '2.0.0',
			parameterHash: V2.parameterHash,
			run: {
				id: 42,
				attempt: 2,
				startedAt: '2026-11-28T15:00:00.000Z',
				observedAt: '2026-11-28T15:00:05.000Z',
			},
			responses: [
				{
					url: `${SITE}/incidents`,
					date: 'Sat, 28 Nov 2026 15:00:05 GMT',
					deployedCommit: COMMIT,
					body: '2.0.0.readback.incidents.html',
				},
				{
					url: `${SITE}/api/v1/methodology`,
					date: 'Sat, 28 Nov 2026 15:00:06 GMT',
					body: '2.0.0.readback.methodology.json',
				},
			],
			noticeAt: '2026-11-28T15:00:06.000Z',
		});
		// Each body is kept under the name the record gives it, matching the hash it records.
		expect(readback.bodies.map(({ name, bytes }) => [name, sha256Hex(bytes)])).toEqual(
			readback.record.responses.map(({ body, bodySha256 }) => [body, bodySha256]),
		);
		expect(new TextDecoder().decode(readback.bodies[0]?.bytes)).toBe(SHOWN);
		// A server clock a little behind never moves N before the run saw the notice.
		const behind = await readBackNotice(
			SITE,
			V2,
			RUN,
			CLOCK,
			site({
				incidents: SHOWN,
				upcoming,
				dates: ['Sat, 28 Nov 2026 14:58:00 GMT', 'Sat, 28 Nov 2026 14:58:01 GMT'],
			}),
		);
		expect(behind).toMatchObject({ record: { noticeAt: '2026-11-28T15:00:05.000Z' } });
	});

	it('fails, never records, when the site states the release under another hash', async () => {
		const wrong = { version: '2.0.0', parameterHash: 'f'.repeat(64) };
		await expect(
			readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents: SHOWN, upcoming: wrong })),
		).rejects.toThrow(`with parameter hash "${'f'.repeat(64)}", not ${V2.parameterHash}`);
	});

	describe('(Sol #37 r1)', () => {
		it('refuses a Date header outside the runner’s own observation of the request (finding 1)', async () => {
			for (const dates of [
				['Thu, 01 Jan 2099 00:00:00 GMT', 'Sat, 28 Nov 2026 15:00:06 GMT'],
				['Sat, 28 Nov 2026 14:00:00 GMT', 'Sat, 28 Nov 2026 15:00:06 GMT'],
				['Sat, 28 Nov 2026 15:06:06 GMT', 'Sat, 28 Nov 2026 15:00:06 GMT'],
			] as [string, string][]) {
				await expect(
					readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents: SHOWN, upcoming, dates })),
				).rejects.toThrow('outside this run’s observation');
			}
		});

		it('counts only the visible page: never a headline in a script, a style or a comment (finding 2)', async () => {
			for (const hidden of [
				`<script>self.__next_f.push("${noticeHeadline(V2)}")</script><p>no notice</p>`,
				`<style>/* ${noticeHeadline(V2)} */</style><p>no notice</p>`,
				`<!-- ${noticeHeadline(V2)} --><p>no notice</p>`,
			]) {
				expect(
					await readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents: hidden, upcoming })),
				).toMatchObject({ kind: 'not_public' });
			}
		});

		it('refuses a response without a deployed commit, or redirected anywhere (finding 2)', async () => {
			for (const commit of [null, 'unknown']) {
				await expect(
					readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents: SHOWN, upcoming, commit })),
				).rejects.toThrow('names no deployed commit');
			}
			await expect(
				readBackNotice(
					SITE,
					V2,
					RUN,
					CLOCK,
					site({ incidents: SHOWN, upcoming, redirectedTo: 'https://elsewhere.test/incidents' }),
				),
			).rejects.toThrow('was redirected to "https://elsewhere.test/incidents"');
		});

		it('never echoes response text that could read as a workflow command (finding 6)', async () => {
			const injected = { version: '2.0.0', parameterHash: 'ab\n::error::forged' };
			const readback = readBackNotice(
				SITE,
				V2,
				RUN,
				CLOCK,
				site({ incidents: SHOWN, upcoming: injected }),
			);
			await expect(readback).rejects.toThrow(
				`states 2.0.0 with parameter hash "ab\\n::error::forged", not ${V2.parameterHash}`,
			);
		});
	});

	it('keeps the workflow’s cheap gate on the registry’s notice instant (Opus #37 r1, finding 6)', () => {
		const workflow = readFileSync('.github/workflows/notice-readback.yml', 'utf8');
		const version = /\n {2}VERSION: '([^']+)'/.exec(workflow)?.[1];
		const noticeAt = /\n {2}NOTICE_AT: '([^']*)'/.exec(workflow)?.[1];
		const notified = RELEASES.find((candidate) => candidate.parameters.version === version);
		expect(notified).toBeDefined();
		expect(noticeAt).toBe(notified?.noticePublishedAt ?? '');
	});

	describe('(Sol #37 r2)', () => {
		const headline = noticeHeadline(V2);
		const recorded = async (incidents: string, incidentsType?: string) =>
			(await readBackNotice(SITE, V2, RUN, CLOCK, site({ incidents, upcoming, incidentsType })))
				.kind;

		it('reads the rendered page: entities decoded, the headline and the hash both visible (finding 1)', async () => {
			expect(
				await recorded(entry(headline.replace('v2.0.0', '&#118;2.0.0'), V2.parameterHash)),
			).toBe('recorded');
			expect(await recorded(`<li><strong>${headline}</strong></li>`)).toBe('not_public');
		});

		it('never counts hidden elements, attributes, or a page that is not HTML (finding 1)', async () => {
			for (const hidden of [
				`<div hidden>${entry(headline, V2.parameterHash)}</div>`,
				`<div style="display: none">${entry(headline, V2.parameterHash)}</div>`,
				`<div style="visibility:hidden">${entry(headline, V2.parameterHash)}</div>`,
				`<div class="sr-only">${entry(headline, V2.parameterHash)}</div>`,
				`<p title="${headline} ${V2.parameterHash}">no notice</p>`,
				`<input type="hidden" value="${headline} ${V2.parameterHash}">`,
			]) {
				expect(await recorded(hidden), hidden).toBe('not_public');
			}
			for (const type of ['application/json', 'text/x-component']) {
				expect(await recorded(SHOWN, type), type).toBe('not_public');
			}
		});

		it('keeps each request’s own timing and refuses a Date that is not an HTTP-date (finding 2)', async () => {
			const readback = await readBackNotice(
				SITE,
				V2,
				RUN,
				CLOCK,
				site({ incidents: SHOWN, upcoming }),
			);
			if (readback.kind !== 'recorded') throw new Error('expected a record');
			expect(readback.record.responses[0]).toMatchObject({
				requestedAt: '2026-11-28T15:00:05.000Z',
				receivedAt: '2026-11-28T15:00:05.000Z',
			});
			await expect(
				readBackNotice(
					SITE,
					V2,
					RUN,
					CLOCK,
					site({
						incidents: SHOWN,
						upcoming,
						dates: ['2026-11-28 15:00:05', 'Sat, 28 Nov 2026 15:00:06 GMT'],
					}),
				),
			).rejects.toThrow('is not an HTTP-date');
		});

		it('accepts an edge cache’s older Date, which never moves N before the run saw it', async () => {
			const cached = await readBackNotice(
				SITE,
				V2,
				RUN,
				CLOCK,
				site({
					incidents: SHOWN,
					upcoming,
					dates: ['Sat, 28 Nov 2026 15:00:05 GMT', 'Sat, 28 Nov 2026 14:20:00 GMT'],
				}),
			);
			expect(cached).toMatchObject({
				kind: 'recorded',
				record: { noticeAt: '2026-11-28T15:00:05.000Z' },
			});
		});

		it('refuses a redirect response itself, without following it (finding 5)', async () => {
			await expect(
				readBackNotice(
					SITE,
					V2,
					RUN,
					CLOCK,
					site({ incidents: SHOWN, upcoming, redirectStatus: 307 }),
				),
			).rejects.toThrow('answered a redirect (HTTP 307)');
		});
	});
});
