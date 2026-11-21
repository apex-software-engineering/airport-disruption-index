import { describe, expect, it } from 'vitest';

import { METHODOLOGY_V1 } from '@/lib/index/releases';

import { DOC_NAMES, DOC_ROUTES, headingId, readDoc, renderDoc, siteHref } from './docs';

describe('docs rendering', () => {
	it('gives headings GitHub-style ids', () => {
		expect(headingId('History / backfill')).toBe('history--backfill');
		expect(headingId('Carry/suspend ladder')).toBe('carrysuspend-ladder');
		expect(headingId('Source')).toBe('source');
	});

	it('maps doc links to site routes and leaves other links alone', () => {
		expect(siteHref('sources.md')).toBe('/sources');
		expect(siteHref('methodology.md#source')).toBe('/methodology#source');
		expect(siteHref('https://aspm.faa.gov/x.html')).toBe('https://aspm.faa.gov/x.html');
		expect(siteHref('#versioning')).toBe('#versioning');
		expect(() => siteHref('../fixtures/feed/README.md')).toThrow(/no page on the site/);
	});

	it.each(DOC_NAMES)('renders docs/%s.md', async (name) => {
		expect(await renderDoc(name)).toContain('<h1 id=');
	});

	it('documents the methodology version the code runs', async () => {
		const [title] = (await readDoc('methodology')).split('\n');
		expect(title).toContain(`v${METHODOLOGY_V1.version}`);
	});

	it('resolves every in-site anchor to a heading of the target doc', async () => {
		const rendered = Object.fromEntries(
			await Promise.all(
				DOC_NAMES.map(async (name) => [DOC_ROUTES[name], await renderDoc(name)] as const),
			),
		);
		for (const html of Object.values(rendered)) {
			for (const [, route, hash] of html.matchAll(/href="(\/[a-z]+)#([^"]+)"/g)) {
				expect(rendered[route ?? ''], `${route}#${hash}`).toContain(`id="${hash}"`);
			}
		}
	});
});
