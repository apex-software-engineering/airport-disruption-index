import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { GET } from './route';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-history-'));
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

it('returns an empty history, not an error, for a range entirely before the first release', async () => {
	const response = await GET(
		new Request('http://test/api/v1/history?from=2026-10-01&to=2026-10-31'),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		from: '2026-10-01',
		to: '2026-10-31',
		methodologyVersion: null,
		days: [],
	});
});

it('names the methodology in effect at the end of a range that reaches it', async () => {
	const response = await GET(
		new Request('http://test/api/v1/history?from=2026-11-01&to=2026-11-20'),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ methodologyVersion: '1.0.0', days: [] });
});
