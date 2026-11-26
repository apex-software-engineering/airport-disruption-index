import { createServer, type RequestListener } from 'node:http';

import { describe, expect, it } from 'vitest';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syntheticProof } from '@/test/ots';

import { proveFile } from './attestations';
import { CannotVerify, fetchWhole, printable } from './public-api';

async function serving(handler: RequestListener, run: (base: string) => Promise<void>) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no TCP address');
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
}

describe('fetchWhole (Sol #41 r1, finding 5)', () => {
	it('gives up on a body that stalls partway, as could-not-verify', async () => {
		await serving(
			(_request, response) => {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.write('{"print": ');
			},
			async (base) => {
				const started = Date.now();
				const fetched = fetchWhole(`${base}/stalls`, {}, 200);
				await expect(fetched).rejects.toThrow(CannotVerify);
				await expect(fetched).rejects.toThrow(/no complete response within 0.2 s/);
				expect(Date.now() - started).toBeLessThan(5_000);
			},
		);
	});

	it('keeps the status, headers, body, final URL and redirect of a whole response', async () => {
		await serving(
			(request, response) => {
				if (request.url === '/start') response.writeHead(302, { Location: '/end' }).end();
				else response.writeHead(404, { Date: 'Sun, 29 Nov 2026 00:20:05 GMT' }).end('{"a":1}');
			},
			async (base) => {
				const response = await fetchWhole(`${base}/start`, { redirect: 'follow' }, 5_000);
				expect([response.status, response.redirected, response.url]).toEqual([
					404,
					true,
					`${base}/end`,
				]);
				expect(response.headers.get('Date')).toBe('Sun, 29 Nov 2026 00:20:05 GMT');
				expect(await response.json()).toEqual({ a: 1 });
				const manual = await fetchWhole(`${base}/start`, { redirect: 'manual' }, 5_000);
				expect([manual.status, manual.headers.get('Location')]).toEqual([302, '/end']);
			},
		);
	});
});

describe('output the Actions runner reads (Sol #46 r1, finding 6)', () => {
	it('keeps a pending diagnostic carrying a calendar URL with a line break on one line', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'adi-printable-'));
		try {
			const file = new TextEncoder().encode('pin');
			const calendarUrl = 'https://a.example\n::error::injected';
			const { proof } = syntheticProof(file, { kind: 'pending', calendarUrl });
			await writeFile(path.join(directory, 'pin.ots'), proof);
			const verdict = await proveFile(path.join(directory, 'pin.ots'), file, new Date(0));
			if (verdict.kind !== 'pending') throw new Error(`expected pending, got ${verdict.kind}`);
			// The parser passes the line break through: without escaping, `::error::` starts a line.
			expect(verdict.detail).toContain('\n::error::injected');
			const line = printable(`2026-12-31: indicative PENDING: ${verdict.detail}`);
			expect(line.split('\n')).toHaveLength(1);
			expect(line).toContain('a.example\\u000a::error::injected');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
