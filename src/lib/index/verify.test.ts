import { describe, expect, it } from 'vitest';

import { feedFixture } from '@/test/fixtures';

import { METHODOLOGY } from './methodology';
import { buildPrint } from './print';
import { buildReceipt, summarizeReceipt } from './round';
import { verifyPrint, verifyRound } from './verify';

const raw = feedFixture('synthetic-gs-gdp.xml');
const receipt = buildReceipt({
	fetchedAt: new Date('2026-11-17T20:45:02.123Z'),
	sourceUrl: METHODOLOGY.source.url,
	outcome: { kind: 'response', httpStatus: 200, body: raw },
});

describe('verifyRound', () => {
	it('matches a receipt against its own raw body', () => {
		expect(verifyRound(receipt, raw, receipt.roundId)).toEqual([]);
	});

	it('flags a raw body that is not the archived one', () => {
		const other = feedFixture('live-2026-11-17T20-43-56Z.xml');
		const problems = verifyRound(receipt, other, receipt.roundId);
		expect(problems[0]).toMatch(/raw body sha256/);
		expect(problems).toContain('recomputed observation differs');
	});

	it('flags edited fields even when the hash was recomputed by the editor', () => {
		const forged = {
			...receipt,
			httpStatus: 200,
			observation: { ...receipt.observation, feedUpdateTime: '2026-11-17T20:44:00.000Z' },
		};
		expect(verifyRound(forged, raw, forged.roundId)).toEqual(
			expect.arrayContaining([
				'receiptHash does not match the receipt contents',
				'recomputed observation differs',
			]),
		);
	});

	it('flags a receipt for a different round than the one requested', () => {
		expect(verifyRound(receipt, raw, '2026-11-17T20:50Z')).toEqual([
			'asked for round 2026-11-17T20:50Z, got a receipt for 2026-11-17T20:45Z',
		]);
	});

	it('reports a receipt that cannot be rebuilt instead of throwing', () => {
		const impossible = { ...receipt, httpStatus: null, rawSha256: null, rawBytes: null };
		expect(verifyRound(impossible, null, receipt.roundId)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^cannot be rebuilt: .*valid without an HTTP response/),
			]),
		);
	});
});

describe('verifyPrint', () => {
	const print = buildPrint('2026-11-17', [summarizeReceipt(receipt)], { revision: 1 });

	it('matches a print rebuilt from its receipts', () => {
		expect(verifyPrint(print, [receipt], '2026-11-17')).toEqual([]);
	});

	it('flags a missing receipt', () => {
		expect(verifyPrint(print, [], '2026-11-17')).toContain('print lists 1 rounds, 0 supplied');
	});

	it('flags a print for a different day than the one requested', () => {
		expect(verifyPrint(print, [receipt], '2026-11-18')).toContain(
			'asked for day 2026-11-18, got a print for 2026-11-17',
		);
	});

	it('reports a print that cannot be rebuilt instead of throwing', () => {
		expect(verifyPrint(print, [receipt, receipt], '2026-11-17')).toEqual(
			expect.arrayContaining([expect.stringMatching(/^cannot be rebuilt: two rounds/)]),
		);
	});
});
