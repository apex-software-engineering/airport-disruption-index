import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { buildReceipt } from '@/lib/index/round';
import { recordRound } from '@/server/archive';
import { FileStore } from '@/server/storage';

import { GET } from './route';

let root: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-raw-'));
	vi.stubEnv('ADI_DATA_DIR', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

it('does not cache the 404 for a bodyless invalid round, which a valid retry can replace', async () => {
	const receipt = buildReceipt({
		fetchedAt: new Date('2026-11-17T20:45:03Z'),
		sourceUrl: 'https://nasstatus.faa.gov/api/airport-status-information',
		outcome: { kind: 'network_error', detail: 'ECONNRESET' },
	});
	await recordRound(new FileStore(root), receipt, null, new Date('2026-11-17T20:45:04Z'));
	const response = await GET(new Request('http://test/'), {
		params: Promise.resolve({ id: receipt.roundId }),
	});
	expect(response.status).toBe(404);
	expect(response.headers.get('cache-control')).toBe('no-store');
});
