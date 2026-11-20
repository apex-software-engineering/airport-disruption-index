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
});
