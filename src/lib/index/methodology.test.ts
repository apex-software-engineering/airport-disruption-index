import { describe, expect, it } from 'vitest';

import { effectiveAt, noticeBound } from './calendar';
import { canonicalJson, hashJson, sha256Hex } from './json';
import {
	activeReleases,
	isActive,
	methodologyOf,
	settlementReleaseFor,
	SLOT_MINUTES,
} from './methodology';
import { METHODOLOGY_V1, METHODOLOGY_V2, release, RELEASES } from './releases';
import { addDays } from './time';

/**
 * Released parameter hashes. A change to any methodology parameter changes the hash and fails
 * this test: release it as a new version and add its hash here, never edit an existing entry.
 */
const RELEASED_PARAMETER_HASHES: Record<string, string> = {
	'1.0.0': 'e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363',
	'2.0.0': 'a9fa10889b35417090d909d4f60d9cb9b429a9703d1b626c1c0a95182b7a76e6',
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
		expect(settlementReleaseFor('2026-11-20')).toBe(v1);
		expect(() => settlementReleaseFor('2026-11-16')).toThrow(/no methodology/);
		expect(methodologyOf('1.0.0', RELEASED_PARAMETER_HASHES['1.0.0'] ?? '')).toBe(v1);
		expect(methodologyOf('1.0.0', 'a'.repeat(64))).toBeNull();
		expect(methodologyOf('9.9.9', RELEASED_PARAMETER_HASHES['1.0.0'] ?? '')).toBeNull();
	});

	it('tiles the days of the active releases: each ends the day before the next starts', () => {
		const active = activeReleases();
		active.forEach((current, index) => {
			const next = active[index + 1];
			if (next === undefined) expect(current.effectiveUntil).toBeNull();
			else expect(current.effectiveUntil).toBe(addDays(next.effectiveFrom, -1));
		});
	});

	it('announces a later release only with its proof time and block, at least 30 days before it takes effect', () => {
		RELEASES.slice(1).forEach((later) => {
			const { announcedAt, announcedProofAt, announcedProofHeight } = later;
			if (announcedAt === null) {
				expect([announcedProofAt, announcedProofHeight]).toEqual([null, null]);
				return;
			}
			if (announcedProofAt === null || announcedProofHeight === null)
				throw new Error(`${later.parameters.version} has N without B and its block`);
			// Exactly as the record writes them, so the step-2 check compares like with like.
			expect(new Date(announcedAt).toISOString()).toBe(announcedAt);
			expect(new Date(announcedProofAt).toISOString()).toBe(announcedProofAt);
			expect(effectiveAt(later).getTime()).toBeGreaterThanOrEqual(
				noticeBound(new Date(announcedAt), new Date(announcedProofAt)).getTime(),
			);
		});
		expect(
			noticeBound(new Date('2026-12-02T00:00Z'), new Date('2026-12-01T23:00Z')).toISOString(),
		).toBe('2027-01-01T00:00:00.000Z');
		expect(
			noticeBound(new Date('2026-11-29T00:20Z'), new Date('2026-11-29T01:10Z')).toISOString(),
		).toBe('2026-12-29T01:10:00.000Z');
	});

	it('activates a later release only once announced, and never once withdrawn', () => {
		const announced = { announcedAt: '2026-11-25T15:00:00.000Z' };
		expect(isActive(release(METHODOLOGY_V2, '2027-01-01'))).toBe(false);
		expect(isActive(release(METHODOLOGY_V2, '2027-01-01', announced))).toBe(true);
		expect(isActive(release(METHODOLOGY_V2, '2027-01-01', { ...announced, withdrawn: true }))).toBe(
			false,
		);
		expect(RELEASES.map(isActive)).toEqual([true, false]);
	});

	it('gives v2 exactly v1’s parameters but the version and the America/New_York day', () => {
		const { day: v1Day, slotsPerDay, version: v1Version, ...v1Rest } = METHODOLOGY_V1;
		const { day, version, ...v2Rest } = METHODOLOGY_V2;
		expect([v1Day, slotsPerDay, v1Version]).toEqual(['utc', 288, '1.0.0']);
		expect([day, version]).toEqual([{ timeZone: 'America/New_York' }, '2.0.0']);
		expect(v2Rest).toEqual(v1Rest);
	});

	it('gives v1 a panel of 20 distinct 3-letter codes', () => {
		expect(METHODOLOGY_V1.panel).toHaveLength(20);
		expect(new Set(METHODOLOGY_V1.panel).size).toBe(20);
		expect(METHODOLOGY_V1.panel.every((code) => /^[A-Z]{3}$/.test(code))).toBe(true);
	});

	it('has internally consistent slot parameters', () => {
		expect(1440 % SLOT_MINUTES).toBe(0);
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
