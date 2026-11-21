import { describe, expect, it } from 'vitest';

import { canonicalJson, hashJson, sha256Hex } from './json';
import { methodologyFor, methodologyOf, SLOT_MINUTES, SLOTS_PER_DAY } from './methodology';
import { METHODOLOGY_V1, RELEASES } from './releases';

/**
 * Released parameter hashes. A change to any methodology parameter changes the hash and fails
 * this test: release it as a new version and add its hash here, never edit an existing entry.
 */
const RELEASED_PARAMETER_HASHES: Record<string, string> = {
	'1.0.0': 'e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363',
};

describe('methodology registry', () => {
	it('pins the parameter hash of every release', () => {
		for (const release of RELEASES) {
			expect(RELEASED_PARAMETER_HASHES[release.parameters.version]).toBe(release.parameterHash);
			expect(hashJson(release.parameters)).toBe(release.parameterHash);
		}
		expect(RELEASES.map((r) => r.parameters.version)).toEqual(
			Object.keys(RELEASED_PARAMETER_HASHES),
		);
	});

	it('lists releases in effect order with distinct versions', () => {
		const days = RELEASES.map((r) => r.effectiveFrom);
		expect([...days].sort()).toEqual(days);
		expect(new Set(days).size).toBe(days.length);
		expect(new Set(RELEASES.map((r) => r.parameters.version)).size).toBe(RELEASES.length);
	});

	it('selects the release in effect on a day, and only a known release by version and hash', () => {
		const [v1] = RELEASES;
		expect(methodologyFor('2026-11-20')).toBe(v1);
		expect(() => methodologyFor('2026-11-16')).toThrow(/no methodology/);
		expect(methodologyOf('1.0.0', RELEASED_PARAMETER_HASHES['1.0.0'] ?? '')).toBe(v1);
		expect(methodologyOf('1.0.0', 'a'.repeat(64))).toBeNull();
		expect(methodologyOf('9.9.9', RELEASED_PARAMETER_HASHES['1.0.0'] ?? '')).toBeNull();
	});

	it('gives v1 a panel of 20 distinct 3-letter codes', () => {
		expect(METHODOLOGY_V1.panel).toHaveLength(20);
		expect(new Set(METHODOLOGY_V1.panel).size).toBe(20);
		expect(METHODOLOGY_V1.panel.every((code) => /^[A-Z]{3}$/.test(code))).toBe(true);
	});

	it('has internally consistent slot parameters', () => {
		expect(SLOTS_PER_DAY * SLOT_MINUTES).toBe(1440);
		for (const { parameters } of RELEASES) {
			expect(parameters.minutesPerActiveSlot).toBe(SLOT_MINUTES);
		}
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
