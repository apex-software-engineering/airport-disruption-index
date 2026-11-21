import { describe, expect, it } from 'vitest';

import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { collectedReceipt } from '@/test/receipts';
import { feedFixture } from '@/test/fixtures';

import { methodologyFor } from './methodology';
import { METHODOLOGY_V1 } from './releases';
import {
	buildReceipt,
	outcomeFromReceipt,
	receiptHashMatches,
	summarizeReceipt,
	type FetchOutcome,
} from './round';
import { receiptSchema } from './schemas';

const SOURCE = CURRENT_ADAPTER.url;
/** Update_Time in every fixture except the second live one. */
const UPDATE = Date.parse('2026-11-17T20:43:54Z');

function receiptAt(offsetSeconds: number, outcome: FetchOutcome) {
	return collectedReceipt({
		fetchedAt: new Date(UPDATE + offsetSeconds * 1000),
		sourceUrl: SOURCE,
		outcome,
	});
}

/** A receipt in the shape written before receipts recorded `adapterVersion`. */
function unrecordedAdapterReceipt(fetchedAt: Date, outcome: FetchOutcome) {
	return buildReceipt({
		fetchedAt,
		sourceUrl: SOURCE,
		outcome,
		methodology: methodologyFor('2026-11-17'),
		adapterVersion: undefined,
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
			unrecognized: [],
		});
	});

	it('carries unrecognized lists into the summary, and only those', () => {
		const summary = summarizeReceipt(receiptAt(60, ok('synthetic-edge-cases.xml')));
		expect(summary.observation).toMatchObject({
			status: 'valid',
			unrecognized: [
				{ name: 'Deicing', element: 'Deicing_List' },
				{ name: 'Empty block', element: null },
			],
		});
	});

	it('accepts a feed exactly at the age limit and rejects one a second older', () => {
		const limit = METHODOLOGY_V1.observation.maxFeedAgeSeconds;
		expect(receiptAt(limit, ok('synthetic-gs-gdp.xml')).observation.status).toBe('valid');
		const stale = receiptAt(limit + 1, ok('synthetic-gs-gdp.xml')).observation;
		expect(stale).toMatchObject({
			status: 'invalid',
			reason: 'stale_feed',
			feedUpdateTime: '2026-11-17T20:43:54.000Z',
		});
	});

	it('rejects a feed time too far ahead of the fetch clock', () => {
		const lead = METHODOLOGY_V1.observation.maxFeedLeadSeconds;
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

	it('keeps the pre-adapter receipt shape and hash when no adapter is recorded', () => {
		const receipt = unrecordedAdapterReceipt(new Date(UPDATE + 2000), ok('synthetic-gs-gdp.xml'));
		expect('adapterVersion' in receipt).toBe(false);
		expect(receiptSchema.parse(receipt)).toEqual(receipt);
		const rebuilt = buildReceipt({
			fetchedAt: new Date(receipt.fetchedAt),
			sourceUrl: receipt.sourceUrl,
			outcome: outcomeFromReceipt(receipt, feedFixture('synthetic-gs-gdp.xml')),
			methodology: methodologyFor('2026-11-17'),
			adapterVersion: receipt.adapterVersion,
		});
		expect(rebuilt).toEqual(receipt);
		// Pinned before adapterVersion existed: every archived receipt still hashes the same.
		expect(receipt.receiptHash).toBe(
			'eb376390979dcf0ceb9bde008f0dacaad06232251edb704453defc1013ac0359',
		);
	});

	it('records the adapter in new receipts, inside the hash, deterministically', () => {
		const first = receiptAt(2, ok('synthetic-gs-gdp.xml'));
		const second = receiptAt(2, ok('synthetic-gs-gdp.xml'));
		expect(first.adapterVersion).toBe('faa-nas-xml/2');
		expect(second).toEqual(first);
		expect(receiptHashMatches(first)).toBe(true);
		expect(receiptHashMatches({ ...first, adapterVersion: 'faa-nas-xml/1' })).toBe(false);
		// The same round as the pre-adapter receipt above, now with the adapter in the hash.
		expect(first.receiptHash).toBe(
			'a947802e0a35ab345175be38e9294f1ed8b3fac086b7a1b1c1bde80830ae2380',
		);
	});

	it('rejects a receipt that records an adapter this code does not know', () => {
		const receipt = receiptAt(2, ok('synthetic-gs-gdp.xml'));
		expect(receiptSchema.safeParse({ ...receipt, adapterVersion: 'nope/9' }).success).toBe(false);
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
		// Recorded from the live feed by the preview collector, round 2026-11-20T01:00Z, before
		// receipts recorded their adapter.
		const receipt = unrecordedAdapterReceipt(
			new Date('2026-11-20T01:03:33.053Z'),
			ok('live-2026-11-20T01-03-33Z.xml'),
		);
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
