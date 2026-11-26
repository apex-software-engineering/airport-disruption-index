import { describe, expect, it } from 'vitest';

import { RELEASES } from '@/lib/index/releases';
import { noticeHeadline } from '@/lib/notice-readback';

import {
	DOC_NAMES,
	DOC_ROUTES,
	gateNotices,
	headingId,
	readDoc,
	renderDoc,
	siteHref,
} from './docs';

/** Either side of v2.0.0's notice instant (noticePublishedAt). */
const BEFORE = new Date('2026-11-28T23:59:59.999Z');
const FROM = new Date('2026-11-29T00:00:00.000Z');
const INSTANTS = [
	['before the notice', BEFORE],
	['from the notice', FROM],
] as const;

describe('docs rendering', () => {
	it('gives headings GitHub-style ids', () => {
		expect(headingId('History / backfill')).toBe('history--backfill');
		expect(headingId('Carry/suspend ladder')).toBe('carrysuspend-ladder');
		expect(headingId('Source')).toBe('source');
	});

	it('maps doc links to site routes and leaves other links alone', () => {
		expect(siteHref('sources.md')).toBe('/sources');
		expect(siteHref('independence.md')).toBe('/independence');
		expect(siteHref('methodology.md#source')).toBe('/methodology#source');
		expect(siteHref('https://aspm.faa.gov/x.html')).toBe('https://aspm.faa.gov/x.html');
		expect(siteHref('#versioning')).toBe('#versioning');
		expect(() => siteHref('../fixtures/feed/README.md')).toThrow(/no page on the site/);
	});

	it.each(DOC_NAMES.flatMap((name) => INSTANTS.map(([when, now]) => [name, when, now] as const)))(
		'renders docs/%s.md %s, with one title',
		async (name, _, now) => {
			expect((await renderDoc(name, now)).match(/<h1 id=/g)).toHaveLength(1);
		},
	);

	it('shows a notice’s passages from its instant and the passages it replaces until then', async () => {
		const before = await renderDoc('methodology', BEFORE);
		expect(before).toContain('methodology v1.0.0</h1>');
		expect(before).not.toContain('v2.0.0');
		expect(await renderDoc('incidents', BEFORE)).not.toContain('v2.0.0');
		const from = await renderDoc('methodology', FROM);
		expect(from).toContain('id="settlement-rules-v200-et-days-from-2027-01-01"');
		expect(from).toContain('id="settlement-rules-v100-utc-days-2026-11-17-to-2026-12-31"');
		expect(from).not.toContain('methodology v1.0.0</h1>');
	});

	it('refuses a notice marker naming no release, or left unclosed', () => {
		expect(() => gateNotices('<!-- notice 9.9.9 -->\nx\n<!-- /notice -->\n', FROM)).toThrow(
			'docs mark a notice of 9.9.9, no release',
		);
		expect(() => gateNotices('<!-- notice 2.0.0 -->\nx\n', FROM)).toThrow('unclosed');
	});

	it('documents every registered version, with its parameter hash, in the version history', async () => {
		const doc = await readDoc('methodology');
		const history = doc.slice(
			doc.indexOf('## Version history'),
			doc.indexOf('## What is published'),
		);
		for (const release of RELEASES) {
			expect(history).toContain(`v${release.parameters.version}`);
			expect(history).toContain(release.parameterHash);
		}
	});

	it('publishes no provisional rule (design §7)', async () => {
		expect(await readDoc('methodology')).not.toContain('PROVISIONAL');
	});

	it('announces each published notice with the headline its readback looks for', async () => {
		const log = (await renderDoc('incidents', FROM)).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
		for (const release of RELEASES.filter((r) => r.noticePublishedAt !== null)) {
			expect(log).toContain(noticeHeadline(release));
			expect(log).toContain(release.parameterHash);
		}
	});

	it.each(INSTANTS)(
		'resolves every in-site anchor to a heading of the target doc %s',
		async (_, now) => {
			const rendered = Object.fromEntries(
				await Promise.all(
					DOC_NAMES.map(async (name) => [DOC_ROUTES[name], await renderDoc(name, now)] as const),
				),
			);
			for (const html of Object.values(rendered)) {
				for (const [, route, hash] of html.matchAll(/href="(\/[a-z]+)#([^"]+)"/g)) {
					expect(rendered[route ?? ''], `${route}#${hash}`).toContain(`id="${hash}"`);
				}
			}
		},
	);
});
