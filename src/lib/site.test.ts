import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { cloneCommand, site } from '@/lib/site';

describe('site', () => {
	it('carries the required footer attribution', () => {
		expect(site.footer).toBe('An Apex Software Engineering index');
	});

	it('shows the same clone command in the methodology doc as on the API page', () => {
		expect(readFileSync('docs/methodology.md', 'utf8')).toContain(cloneCommand);
	});

	it('states the same data attribution in the terms as the site uses', () => {
		// Prettier may wrap the quoted credit across lines.
		const terms = readFileSync('docs/terms.md', 'utf8').replace(/\s+/g, ' ');
		expect(terms).toContain(`"${site.dataAttribution}"`);
	});
});
