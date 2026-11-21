import { describe, expect, it } from 'vitest';

import { json, problem, untrustedBytes } from './http';

describe('API response headers', () => {
	it('name the deployed commit on every response, readable cross-origin', () => {
		for (const response of [
			json({}, 'no-store'),
			problem(404, 'not found'),
			untrustedBytes(new Uint8Array(), 'text/xml', 'no-store'),
		]) {
			expect(response.headers.get('X-Deployed-Commit')).toBe('unknown');
			expect(response.headers.get('Access-Control-Expose-Headers')).toBe('X-Deployed-Commit');
		}
	});
});
