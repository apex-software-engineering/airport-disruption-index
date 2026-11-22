import { describe, expect, it } from 'vitest';

import { indicativeWriteRefusal } from './indicative-target';

describe('where npm run indicative may write', () => {
	it('refuses production before the series is published, and allows rehearsal stores', () => {
		expect(indicativeWriteRefusal({ VERCEL_ENV: 'production' }, false)).toMatch(
			/not yet published/,
		);
		expect(indicativeWriteRefusal({ VERCEL_ENV: 'preview' }, false)).toBeNull();
		expect(indicativeWriteRefusal({ VERCEL_ENV: 'development' }, false)).toBeNull();
		// ADI_DATA_DIR wins over VERCEL_ENV, so this is a filesystem store.
		expect(
			indicativeWriteRefusal({ VERCEL_ENV: 'production', ADI_DATA_DIR: '/tmp/x' }, false),
		).toBeNull();
	});

	it('allows production once the series is published', () => {
		expect(indicativeWriteRefusal({ VERCEL_ENV: 'production' }, true)).toBeNull();
	});
});
