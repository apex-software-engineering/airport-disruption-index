import { describe, expect, it } from 'vitest';

import { feedFixture } from '@/test/fixtures';

import { METHODOLOGY } from './methodology';
import {
	buildReceipt,
	outcomeFromReceipt,
	receiptHashMatches,
	summarizeReceipt,
	type FetchOutcome,
} from './round';
import { receiptSchema } from './schemas';

const SOURCE = METHODOLOGY.source.url;
/** Update_Time in every fixture except the second live one. */
const UPDATE = Date.parse('2026-11-17T20:43:54Z');

function receiptAt(offsetSeconds: number, outcome: FetchOutcome) {
	return buildReceipt({
		fetchedAt: new Date(UPDATE + offsetSeconds * 1000),
		sourceUrl: SOURCE,
		outcome,
	});
}

const ok = (name: string): FetchOutcome => ({
	kind: 'response',
	httpStatus: 200,
	body: feedFixture(name),
});

describe('buildReceipt', () => {
	it('records a valid round from the live feed with an all-clear panel', () => {
		const receipt = receiptAt(2, ok('live-2026-11-17T20-43-56Z.xml'));
		expect(receiptSchema.parse(receipt)).toEqual(receipt);
		expect(receipt.roundId).toBe('2026-11-17T20:40Z');
		expect(receipt.slotStart).toBe('2026-11-17T20:40:00.000Z');
		expect(receipt.fetchedAt).toBe('2026-11-17T20:43:56.000Z');
		expect(receipt.httpStatus).toBe(200);
		expect(receipt.rawBytes).toBe(2220);
		expect(receipt.observation.status).toBe('valid');
		if (receipt.observation.status !== 'valid') return;
		expect(receipt.observation.panel).toHaveLength(20);
		expect(receipt.observation.panel.some((r) => r.groundStop || r.groundDelayProgram)).toBe(false);
		expect(receiptHashMatches(receipt)).toBe(true);
	});

	it('sets per-airport state from GS and GDP events, panel airports only', () => {
		const receipt = receiptAt(60, ok('synthetic-gs-gdp.xml'));
		const summary = summarizeReceipt(receipt);
		expect(summary.observation).toEqual({
			status: 'valid',
			feedUpdateTime: '2026-11-17T20:43:54.000Z',
			active: [
				{ airport: 'SFO', groundStop: false, groundDelayProgram: true },
				{ airport: 'LGA', groundStop: true, groundDelayProgram: true },
			],
		});
	});

	it('accepts a feed exactly at the age limit and rejects one a second older', () => {
		const limit = METHODOLOGY.observation.maxFeedAgeSeconds;
		expect(receiptAt(limit, ok('synthetic-gs-gdp.xml')).observation.status).toBe('valid');
		const stale = receiptAt(limit + 1, ok('synthetic-gs-gdp.xml')).observation;
		expect(stale).toMatchObject({
			status: 'invalid',
			reason: 'stale_feed',
			feedUpdateTime: '2026-11-17T20:43:54.000Z',
		});
	});

	it('rejects a feed time too far ahead of the fetch clock', () => {
		const lead = METHODOLOGY.observation.maxFeedLeadSeconds;
		expect(receiptAt(-lead, ok('synthetic-gs-gdp.xml')).observation.status).toBe('valid');
		expect(receiptAt(-lead - 1, ok('synthetic-gs-gdp.xml')).observation).toMatchObject({
			reason: 'feed_ahead_of_clock',
		});
	});

	it('records HTTP errors, network errors and undecodable bodies as invalid', () => {
		const html = new TextEncoder().encode('<html>Website Unavailable</html>');
		const http = receiptAt(1, { kind: 'response', httpStatus: 404, body: html });
		expect(http.observation).toMatchObject({
			status: 'invalid',
			reason: 'http_status',
			detail: 'HTTP 404',
		});
		expect(http.rawBytes).toBe(html.byteLength);

		const network = receiptAt(1, { kind: 'network_error', detail: 'timeout after 10000ms' });
		expect(network.observation).toMatchObject({ status: 'invalid', reason: 'network_error' });
		expect([network.httpStatus, network.rawSha256, network.rawBytes]).toEqual([null, null, null]);

		const binary = receiptAt(1, {
			kind: 'response',
			httpStatus: 200,
			body: new Uint8Array([0xff, 0xfe]),
		});
		expect(binary.observation).toMatchObject({ reason: 'parse_error' });
	});

	it('is reproducible from the archived body and has a stable hash', () => {
		const receipt = receiptAt(2, ok('synthetic-gs-gdp.xml'));
		const rebuilt = buildReceipt({
			fetchedAt: new Date(receipt.fetchedAt),
			sourceUrl: receipt.sourceUrl,
			outcome: outcomeFromReceipt(receipt, feedFixture('synthetic-gs-gdp.xml')),
		});
		expect(rebuilt).toEqual(receipt);
		expect(receipt.receiptHash).toBe(
			'eb376390979dcf0ceb9bde008f0dacaad06232251edb704453defc1013ac0359',
		);
	});

	it('detects a tampered receipt', () => {
		const receipt = receiptAt(2, ok('synthetic-gs-gdp.xml'));
		expect(receiptHashMatches({ ...receipt, fetchedAt: '2026-11-17T20:43:57.000Z' })).toBe(false);
	});

	it('rebuilds a network-error receipt without a body', () => {
		const receipt = receiptAt(1, { kind: 'network_error', detail: 'ECONNRESET' });
		expect(outcomeFromReceipt(receipt, null)).toEqual({
			kind: 'network_error',
			detail: 'ECONNRESET',
		});
	});

	it('rebuilds the receipt the preview deployment published for a real GDP round', () => {
		// Recorded from the live feed by the preview collector, round 2026-11-20T01:00Z.
		const receipt = buildReceipt({
			fetchedAt: new Date('2026-11-20T01:03:33.053Z'),
			sourceUrl: SOURCE,
			outcome: ok('live-2026-11-20T01-03-33Z.xml'),
		});
		expect(receipt.rawSha256).toBe(
			'7da1d45a9ef99f1917d13e418ec8bd73f222fee288cb772a0b13ee7a24577083',
		);
		expect(summarizeReceipt(receipt).observation).toMatchObject({
			status: 'valid',
			active: [
				{ airport: 'LAS', groundStop: false, groundDelayProgram: true },
				{ airport: 'SFO', groundStop: false, groundDelayProgram: true },
			],
		});
		expect(receipt.receiptHash).toBe(
			'c874dc80c3238a3589529a00f2f7f98803efde2a2cb8a3f1aa795cc112134824',
		);
	});
});
