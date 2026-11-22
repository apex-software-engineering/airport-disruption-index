import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { cloneCommand, contactEmail, site } from '@/lib/site';

describe('site', () => {
	it('carries the required footer attribution', () => {
		expect(site.footer).toBe('An Apex Software Engineering index');
	});

	it('shows the same clone command in the methodology doc as on the API page', () => {
		expect(readFileSync('docs/methodology.md', 'utf8')).toContain(cloneCommand);
	});

	it('publishes only an email address as the contact', () => {
		expect(contactEmail).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/);
	});

	// Prettier may wrap prose across lines, so whitespace is collapsed before matching.
	const doc = (name: string) => readFileSync(`docs/${name}.md`, 'utf8').replace(/\s+/g, ' ');

	it('states the same data attribution in the terms as the site uses', () => {
		expect(doc('terms')).toContain(`"${site.dataAttribution}"`);
	});

	it.each(['terms', 'disclaimer', 'independence'])(
		'quotes the site contact address in docs/%s.md',
		(name) => {
			expect(doc(name)).toContain(`[${contactEmail}](mailto:${contactEmail})`);
		},
	);

	it.each(['terms', 'disclaimer', 'independence', 'methodology'])(
		'leaves no draft marker in docs/%s.md',
		(name) => {
			expect(doc(name)).not.toMatch(/TODO|PROVISIONAL|TBD/);
		},
	);
});
