import { afterEach, describe, expect, it, vi } from 'vitest';

import { METHODOLOGY_V2, RELEASES } from '@/lib/index/releases';

import { GET } from './route';

afterEach(() => {
	vi.useRealTimers();
});

async function methodologyAt(at: string) {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(at));
	return (await GET().json()) as Record<string, unknown>;
}

describe('/api/v1/methodology', () => {
	it('states the upcoming release from its notice instant, which the readback checks', async () => {
		const v2 = RELEASES[1];
		expect(v2?.parameters).toBe(METHODOLOGY_V2);
		expect(await methodologyAt('2026-11-28T23:59:59.999Z')).toMatchObject({ upcoming: null });
		expect(await methodologyAt('2026-11-29T00:00:00Z')).toMatchObject({
			version: '1.0.0',
			upcoming: {
				version: '2.0.0',
				parameterHash: v2?.parameterHash,
				effectiveFrom: '2027-01-01',
				effectiveAt: '2027-01-01T00:00:00.000Z',
				announcedAt: null,
			},
		});
	});

	it('states no upcoming release once its instant has passed', async () => {
		expect(await methodologyAt('2027-01-01T00:00:00Z')).toMatchObject({ upcoming: null });
	});
});
