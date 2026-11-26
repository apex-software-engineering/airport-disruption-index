import { createServer, type RequestListener } from 'node:http';

import { describe, expect, it } from 'vitest';

import { CannotVerify, fetchWhole } from './public-api';

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
