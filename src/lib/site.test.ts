import { describe, expect, it } from 'vitest';

import { site } from '@/lib/site';

describe('site', () => {
	it('carries the required footer attribution', () => {
		expect(site.footer).toBe('An Apex Software Engineering index');
	});
});
