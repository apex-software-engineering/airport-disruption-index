import { describe, expect, it } from 'vitest';

import { resolveStoreTarget } from '@/server/storage';

import { indicativeWriteRefusal } from './indicative-target';

const refusal = (env: Record<string, string>, published: boolean) =>
	indicativeWriteRefusal(resolveStoreTarget(env), published);

describe('where npm run indicative may write', () => {
	it('refuses production before the series is published, and allows rehearsal stores', () => {
		expect(refusal({ VERCEL_ENV: 'production' }, false)).toMatch(/not yet published/);
		expect(refusal({ VERCEL_ENV: 'preview' }, false)).toBeNull();
		expect(refusal({ VERCEL_ENV: 'development' }, false)).toBeNull();
		// ADI_DATA_DIR wins over VERCEL_ENV (storage.resolveStoreTarget): a filesystem store.
		expect(refusal({ VERCEL_ENV: 'production', ADI_DATA_DIR: '/tmp/x' }, false)).toBeNull();
	});

	it('allows production once the series is published', () => {
		expect(refusal({ VERCEL_ENV: 'production' }, true)).toBeNull();
	});
});
