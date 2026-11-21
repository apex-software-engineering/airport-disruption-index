import { describe, expect, it } from 'vitest';

import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { collectedReceipt } from '@/test/receipts';
import { feedFixture } from '@/test/fixtures';

import { methodologyFor } from './methodology';
import { buildPrint } from './print';
import { buildReceipt, summarizeReceipt } from './round';
import { dayResponseProblems, verifyPrint, verifyRound } from './verify';

const raw = feedFixture('synthetic-gs-gdp.xml');
const receipt = collectedReceipt({
	fetchedAt: new Date('2026-11-17T20:45:02.123Z'),
	sourceUrl: CURRENT_ADAPTER.url,
	outcome: { kind: 'response', httpStatus: 200, body: raw },
});

describe('verifyRound across feed adapters', () => {
	/** GS at ATL inside a renamed wrapper: an all-clear to adapter /1, fail-closed to /2. */
	const renamed = new TextEncoder().encode(
		'<AIRPORT_STATUS_INFORMATION><Update_Time>Tue Nov 17 20:43:54 2026 GMT</Update_Time><Delay_Type_V2><Name>Ground Stop Programs</Name><GS_List><Program><ARPT>ATL</ARPT></Program></GS_List></Delay_Type_V2></AIRPORT_STATUS_INFORMATION>',
	);
	const under = (adapterVersion: string | undefined) =>
		buildReceipt({
			fetchedAt: new Date('2026-11-17T20:45:02.123Z'),
			sourceUrl: CURRENT_ADAPTER.url,
			outcome: { kind: 'response', httpStatus: 200, body: renamed },
			methodology: methodologyFor('2026-11-17'),
			adapterVersion,
		});

	it('rebuilds each receipt with the adapter it records, so archived /1 receipts still match', () => {
		const archived = under('faa-nas-xml/1');
		const unrecorded = under(undefined);
		const current = under(CURRENT_ADAPTER.version);
		expect(archived.observation.status).toBe('valid');
		expect(unrecorded.observation.status).toBe('valid');
		expect(current.observation).toMatchObject({
			status: 'invalid',
			reason: 'unrecognized_structure',
		});
		for (const receipt of [archived, unrecorded, current]) {
			expect(verifyRound(receipt, renamed)).toEqual([]);
		}
	});
});

describe('verifyRound', () => {
	it('matches a receipt against its own raw body', () => {
		expect(verifyRound(receipt, raw)).toEqual([]);
	});

	it('flags a raw body that is not the archived one', () => {
		const other = feedFixture('live-2026-11-17T20-43-56Z.xml');
		const problems = verifyRound(receipt, other);
		expect(problems[0]).toMatch(/raw body sha256/);
		expect(problems).toContain('recomputed observation differs');
	});

	it('flags edited fields even when the hash was recomputed by the editor', () => {
		const forged = {
			...receipt,
			httpStatus: 200,
			observation: { ...receipt.observation, feedUpdateTime: '2026-11-17T20:44:00.000Z' },
		};
		expect(verifyRound(forged, raw)).toEqual(
			expect.arrayContaining([
				'receiptHash does not match the receipt contents',
				'recomputed observation differs',
			]),
		);
	});

	it('reports a receipt that cannot be rebuilt instead of throwing', () => {
		const impossible = { ...receipt, httpStatus: null, rawSha256: null, rawBytes: null };
		expect(verifyRound(impossible, null)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^cannot be rebuilt: .*valid without an HTTP response/),
			]),
		);
	});
});

describe('verifyPrint', () => {
	const print = buildPrint('2026-11-17', [summarizeReceipt(receipt)], { revision: 1 });

	it('matches a print rebuilt from its receipts', () => {
		expect(verifyPrint(print, [receipt])).toEqual([]);
	});

	it('flags a missing receipt', () => {
		expect(verifyPrint(print, [])).toContain('print lists 1 rounds, 0 supplied');
	});

	it('reports a print that cannot be rebuilt instead of throwing', () => {
		expect(verifyPrint(print, [receipt, receipt])).toEqual(
			expect.arrayContaining([expect.stringMatching(/^cannot be rebuilt: two rounds/)]),
		);
	});
});

describe('dayResponseProblems', () => {
	const first = buildPrint('2026-11-17', [summarizeReceipt(receipt)], { revision: 1 });
	const second = buildPrint('2026-11-17', [], {
		revision: 2,
		correction: {
			supersedesPrintHash: first.printHash,
			reason: 'test correction',
			issuedAt: '2026-11-18T10:00:00.000Z',
			windowOverride: null,
		},
	});

	it('accepts a print that is the last of its revisions', () => {
		expect(dayResponseProblems('2026-11-17', second, [first, second])).toEqual([]);
	});

	it('rejects a print that is not the last revision', () => {
		expect(dayResponseProblems('2026-11-17', first, [first, second])).toEqual([
			'print is not the last entry in revisions',
		]);
	});

	it('rejects conflicting duplicate revisions', () => {
		const conflicting = buildPrint('2026-11-17', [], { revision: 1 });
		expect(dayResponseProblems('2026-11-17', conflicting, [first, conflicting])).toEqual([
			'revisions[1] is revision 1, expected 2',
		]);
	});

	it('rejects a print for another date', () => {
		expect(dayResponseProblems('2026-11-18', first, [first])).toEqual([
			'asked for day 2026-11-18, got a print for 2026-11-17',
			'revisions[0] is a print for 2026-11-17, not 2026-11-18',
		]);
	});

	it('rejects an empty revision list', () => {
		expect(dayResponseProblems('2026-11-17', first, [])).toEqual([
			'print is not the last entry in revisions',
		]);
	});
});
