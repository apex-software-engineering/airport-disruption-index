import { describe, expect, it } from 'vitest';

import { canonicalJson, hashJson, sha256Hex } from './json';
import { METHODOLOGY, PANEL, PARAMETER_HASH } from './methodology';

/**
 * Released parameter hashes. A change to any methodology parameter changes the hash and fails
 * this test: release it as a new version and add its hash here, never edit an existing entry.
 */
const RELEASED_PARAMETER_HASHES: Record<string, string> = {
	'1.0.0': 'e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363',
};

describe('methodology', () => {
	it('matches the pinned parameter hash for its version', () => {
		expect(RELEASED_PARAMETER_HASHES[METHODOLOGY.version]).toBe(PARAMETER_HASH);
	});

	it('has a panel of 20 distinct 3-letter codes', () => {
		expect(PANEL).toHaveLength(20);
		expect(new Set(PANEL).size).toBe(20);
		expect(PANEL.every((code) => /^[A-Z]{3}$/.test(code))).toBe(true);
	});

	it('has internally consistent slot parameters', () => {
		expect(METHODOLOGY.slotsPerDay * METHODOLOGY.slotMinutes).toBe(1440);
		expect(METHODOLOGY.minutesPerActiveSlot).toBe(METHODOLOGY.slotMinutes);
	});
});

describe('canonical JSON and hashing', () => {
	it('sorts keys at every depth and drops whitespace', () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: 'x' } })).toBe(
			'{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
		);
	});

	it('is independent of key insertion order', () => {
		expect(hashJson({ a: 1, b: [1, 2] })).toBe(hashJson({ b: [1, 2], a: 1 }));
	});

	it('rejects non-finite numbers', () => {
		expect(() => canonicalJson({ a: Number.NaN })).toThrow();
		expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow();
	});

	it('hashes with sha256', () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});
});
