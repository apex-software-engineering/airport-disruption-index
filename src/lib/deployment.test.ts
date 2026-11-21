import { describe, expect, it } from 'vitest';

import { parseDeployedCommit } from './deployment';

describe('parseDeployedCommit', () => {
	it('reads a full commit id', () => {
		expect(parseDeployedCommit('a'.repeat(40))).toBe('a'.repeat(40));
	});

	it("reads 'unknown' as null", () => {
		expect(parseDeployedCommit('unknown')).toBeNull();
	});

	it('rejects anything else, including an empty or abbreviated value', () => {
		expect(() => parseDeployedCommit('')).toThrow(/neither a full commit id/);
		expect(() => parseDeployedCommit('2dda6a4')).toThrow(/neither a full commit id/);
	});
});
