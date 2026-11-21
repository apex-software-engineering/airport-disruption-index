import { describe, expect, it } from 'vitest';

import { otsFixture } from '@/test/fixtures';

import { sha256Hex } from './index/json';
import { OtsFormatError, readOtsProof } from './ots';

describe('readOtsProof', () => {
	it('reads a complete proof down to its Bitcoin block', () => {
		const proof = readOtsProof(otsFixture('hello-world.txt.ots'));
		expect(proof.fileSha256).toBe(sha256Hex(otsFixture('hello-world.txt')));
		expect(proof.attestations).toEqual([
			{
				kind: 'bitcoin',
				height: 358391,
				merkleRoot: '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00',
			},
		]);
	});

	it('reads a pending proof as its calendars', () => {
		const proof = readOtsProof(otsFixture('pending.json.ots'));
		expect(proof.fileSha256).toBe(sha256Hex(otsFixture('pending.json')));
		expect(proof.attestations.map((a) => (a.kind === 'pending' ? a.calendarUrl : a.kind))).toEqual(
			expect.arrayContaining([
				'https://alice.btc.calendar.opentimestamps.org',
				'https://bob.btc.calendar.opentimestamps.org',
				'https://btc.calendar.catallaxy.com',
				'https://finney.calendar.eternitywall.com',
			]),
		);
		expect(proof.attestations.every((a) => a.kind === 'pending')).toBe(true);
	});

	it('rejects a file that is not a proof', () => {
		expect(() => readOtsProof(otsFixture('hello-world.txt'))).toThrow(OtsFormatError);
	});

	it('rejects a truncated proof', () => {
		const bytes = otsFixture('hello-world.txt.ots');
		expect(() => readOtsProof(bytes.subarray(0, bytes.length - 3))).toThrow(OtsFormatError);
	});

	it('rejects an operation whose result would exceed 4096 bytes', () => {
		// Header and file digest from a real proof, then hexlify (0xf3) repeated: 64, 128, ... bytes.
		const header = otsFixture('hello-world.txt.ots').subarray(0, 31 + 1 + 1 + 32);
		const hexlifies = new Uint8Array(20).fill(0xf3);
		expect(() => readOtsProof(new Uint8Array([...header, ...hexlifies]))).toThrow(
			/exceeds 4096 bytes/,
		);
	});

	it('rejects trailing bytes', () => {
		const bytes = otsFixture('hello-world.txt.ots');
		expect(() => readOtsProof(new Uint8Array([...bytes, 0]))).toThrow(/trailing bytes/);
	});
});
