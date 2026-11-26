import { describe, expect, it } from 'vitest';

import { METHODOLOGY_V1, METHODOLOGY_V2, release } from '@/lib/index/releases';
import type { Methodology } from '@/lib/index/methodology';
import {
	READBACK_ORIGIN,
	noticeHeadline,
	readBackNotice,
	readbackRecordName,
	readbackRecordProblems,
	rulesHeading,
	type NoticeReadback,
} from '@/lib/notice-readback';
import type { Get } from '@/lib/reproduce';
import { branchCheckout, type Files } from '@/test/branch-checkout';
import { syntheticProof } from '@/test/ots';

import { verifyNotice } from './notice-record';

const NOTICE = { noticePublishedAt: '2026-11-29T00:00:00.000Z' };
const UNANNOUNCED = release(METHODOLOGY_V2, '2027-01-01', NOTICE);
const HEIGHT = 925_000;
const RECORD = readbackRecordName('2.0.0');

/** The production site once the notice is out, every response dated `date`. */
function site(date: string): Get {
	const headers = { Date: date, 'X-Deployed-Commit': 'a'.repeat(40) };
	const html = (body: string) =>
		new Response(`<html><body>${body}</body></html>`, {
			headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
		});
	return async (url) => {
		if (url === `${READBACK_ORIGIN}/incidents`)
			return html(`<p>${noticeHeadline(UNANNOUNCED)}. Hash ${UNANNOUNCED.parameterHash}.</p>`);
		if (url === `${READBACK_ORIGIN}/methodology`)
			return html(`<h3>${rulesHeading(UNANNOUNCED)}</h3>`);
		return Response.json(
			{ upcoming: { version: '2.0.0', parameterHash: UNANNOUNCED.parameterHash } },
			{ headers },
		);
	};
}

/** A readback run at `at`, as the workflow writes it: the record and its three bodies. */
async function readback(at: string): Promise<{ record: NoticeReadback; files: Files }> {
	const instant = new Date(at);
	const result = await readBackNotice(
		READBACK_ORIGIN,
		UNANNOUNCED,
		{ id: 7, attempt: 1, startedAt: instant },
		() => instant,
		site(instant.toUTCString()),
	);
	if (result.kind !== 'recorded')
		throw new Error(`expected a record: ${result.reasons.join('; ')}`);
	const files: Files = { [RECORD]: `${JSON.stringify(result.record, null, '\t')}\n` };
	for (const { name, bytes } of result.bodies) files[`notices/${name}`] = bytes;
	return { record: result.record, files };
}

/** v1 and v2 with step 2's values: v1 ends the day before v2, v2 announced at N with proof time B. */
function registry(announcedAt: string | null, announcedProofAt: string | null): Methodology[] {
	return [
		release(METHODOLOGY_V1, '2026-11-17', { effectiveUntil: '2026-12-31' }),
		release(METHODOLOGY_V2, '2027-01-01', { ...NOTICE, announcedAt, announcedProofAt }),
	];
}

/**
 * The attestations branch after a readback at `at` whose proof reaches a block at `proofAt`
 * (null: still pending): the record, its bodies and its proof, in one commit.
 */
async function published(at: string, proofAt: string | null) {
	const { record, files } = await readback(at);
	const recordBytes = new TextEncoder().encode(String(files[RECORD]));
	const { proof, merkleRoot } = syntheticProof(
		recordBytes,
		proofAt === null
			? { kind: 'pending', calendarUrl: 'https://alice.btc.calendar.opentimestamps.org' }
			: { kind: 'bitcoin', height: HEIGHT },
	);
	const branch = branchCheckout();
	branch.commit({ ...files, [`${RECORD}.ots`]: proof });
	const blockAt = async (height: number) => {
		if (height !== HEIGHT || proofAt === null) throw new Error(`no block ${height}`);
		return { merkleRoot, time: new Date(proofAt) };
	};
	return { branch, record, files, blockAt };
}

async function verify(
	branch: ReturnType<typeof branchCheckout>,
	releases: Methodology[],
	blockAt: Parameters<typeof verifyNotice>[3],
) {
	const [, v2] = releases;
	if (v2 === undefined) throw new Error('expected v1 and v2');
	return verifyNotice(branch.checkout, v2, releases, blockAt);
}

describe('the step-2 notice check', () => {
	it('verifies N and B from the record and its proof when B is after N', async () => {
		const { branch, blockAt } = await published('2026-11-29T00:20:05Z', '2026-11-29T01:10:00Z');
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z'),
				blockAt,
			),
		).toEqual({
			kind: 'verified',
			noticeAt: '2026-11-29T00:20:05.000Z',
			proofAt: '2026-11-29T01:10:00.000Z',
			bound: '2026-12-29T01:10:00.000Z',
		});
	});

	it('uses N for the bound when the block time B is before it', async () => {
		const { branch, blockAt } = await published('2026-11-29T00:20:05Z', '2026-11-29T00:05:00Z');
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T00:05:00.000Z'),
				blockAt,
			),
		).toMatchObject({ kind: 'verified', bound: '2026-12-29T00:20:05.000Z' });
	});

	it('holds the bound exactly: max(N, B) up to 2026-12-02T00:00Z, and not a second later', async () => {
		const at = await published('2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z');
		expect(
			await verify(
				at.branch,
				registry('2026-12-01T23:00:00.000Z', '2026-12-02T00:00:00.000Z'),
				at.blockAt,
			),
		).toMatchObject({ kind: 'verified', bound: '2027-01-01T00:00:00.000Z' });
		const late = await published('2026-12-02T00:00:01Z', '2026-12-01T23:50:00Z');
		expect(
			await verify(
				late.branch,
				registry('2026-12-02T00:00:01.000Z', '2026-12-01T23:50:00.000Z'),
				late.blockAt,
			),
		).toEqual({
			kind: 'invalid',
			problems: [
				'2.0.0 takes effect at 2027-01-01T00:00:00.000Z, before max(N, B) + 30 days = 2027-01-01T00:00:01.000Z',
			],
		});
	});

	it('refuses a registry whose N or B is not the record’s', async () => {
		const { branch, blockAt } = await published('2026-11-29T00:20:05Z', '2026-11-29T01:10:00Z');
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:00:00.000Z', '2026-11-29T01:00:00.000Z'),
				blockAt,
			),
		).toEqual({
			kind: 'invalid',
			problems: [
				"announcedAt is 2026-11-29T00:00:00.000Z; the record's N is 2026-11-29T00:20:05.000Z",
				`announcedProofAt is 2026-11-29T01:00:00.000Z; the proof's Bitcoin block ${HEIGHT} has time 2026-11-29T01:10:00.000Z`,
			],
		});
	});

	it('reads the record and its bodies as first committed, flagging a later rewrite', async () => {
		const { branch, files, blockAt } = await published(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
		const rewritten = String(files[RECORD]).replace('00:20:05.000Z', '00:00:00.000Z');
		branch.commit({ [RECORD]: rewritten, 'notices/2.0.0.readback.incidents.html': '<p>other</p>' });
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z'),
				blockAt,
			),
		).toEqual({
			kind: 'invalid',
			problems: [
				expect.stringMatching(
					/^notices\/2\.0\.0\.readback\.incidents\.html was modified in [0-9a-f]{40}$/,
				),
				expect.stringMatching(/^notices\/2\.0\.0\.readback\.json was modified in [0-9a-f]{40}$/),
			],
		});
	});

	it('refuses a body that does not match its hash, and a missing one', async () => {
		const { files, blockAt } = await published('2026-11-29T00:20:05Z', '2026-11-29T01:10:00Z');
		const { proof } = syntheticProof(new TextEncoder().encode(String(files[RECORD])), {
			kind: 'bitcoin',
			height: HEIGHT,
		});
		const branch = branchCheckout();
		branch.commit({
			...Object.fromEntries(
				Object.entries(files).filter(([name]) => !name.endsWith('.methodology.json')),
			),
			[`${RECORD}.ots`]: proof,
			'notices/2.0.0.readback.incidents.html': '<p>not what was read</p>',
		});
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z'),
				blockAt,
			),
		).toEqual({
			kind: 'invalid',
			problems: [
				`notices/2.0.0.readback.incidents.html does not match the hash ${RECORD} gives it`,
				'notices/2.0.0.readback.methodology.json is not on the branch',
			],
		});
	});

	it('is pending, not verified, while the proof has no block', async () => {
		const { branch, blockAt } = await published('2026-11-29T00:20:05Z', null);
		expect(await verify(branch, registry('2026-11-29T00:20:05.000Z', null), blockAt)).toEqual({
			kind: 'pending',
			calendars: ['https://alice.btc.calendar.opentimestamps.org'],
		});
	});

	it('refuses a proof that commits to other bytes, and a missing proof or record', async () => {
		const { branch, files, blockAt } = await published(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
		const values = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z');
		branch.commit({
			[`${RECORD}.ots`]: syntheticProof(new Uint8Array([1]), { kind: 'bitcoin', height: HEIGHT })
				.proof,
		});
		expect(await verify(branch, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				`${branch.checkout.directory}/${RECORD}.ots: the proof does not commit to this attestation file`,
			],
		});
		branch.commit({ [`${RECORD}.ots`]: null });
		expect(await verify(branch, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [`${branch.checkout.directory}/${RECORD}.ots does not exist`],
		});
		const empty = branchCheckout();
		empty.commit({ 'README.md': 'attestations' });
		expect(await verify(empty, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [`${RECORD} is not on the branch`],
		});
		expect(files[RECORD]).toBeDefined();
	});

	it('has nothing to check until the release is announced, and refuses B without N', async () => {
		const branch = branchCheckout();
		const unused = async () => {
			throw new Error('no block is read');
		};
		expect(await verify(branch, registry(null, null), unused)).toEqual({ kind: 'not_announced' });
		expect(await verify(branch, registry(null, '2026-11-29T01:10:00.000Z'), unused)).toEqual({
			kind: 'invalid',
			problems: ['announcedProofAt is 2026-11-29T01:10:00.000Z without N'],
		});
	});
});

describe('replaying a readback record', () => {
	it('finds nothing wrong with a record as the readback writes it', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		expect(readbackRecordProblems(record, UNANNOUNCED)).toEqual([]);
	});

	it('refuses a Date outside the run’s observation, a moved N, and another site or release', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		const [first, ...rest] = record.responses;
		if (first === undefined) throw new Error('expected three responses');
		const altered: NoticeReadback = {
			...record,
			parameterHash: 'b'.repeat(64),
			noticeAt: '2026-11-29T00:00:00.000Z',
			responses: [
				{
					...first,
					url: 'https://elsewhere.test/incidents',
					date: 'Sun, 29 Nov 2026 00:30:00 GMT',
				},
				...rest,
			],
		};
		expect(readbackRecordProblems(altered, UNANNOUNCED)).toEqual([
			`the record is for "2.0.0" with parameter hash "${'b'.repeat(64)}", not 2.0.0 with ${UNANNOUNCED.parameterHash}`,
			`response 1 is from "https://elsewhere.test/incidents", not ${READBACK_ORIGIN}/incidents`,
			'response 1 states Date "Sun, 29 Nov 2026 00:30:00 GMT", outside the run\'s observation of it (2026-11-29T00:20:05.000Z to 2026-11-29T00:20:05.000Z)',
			'the record states N 2026-11-29T00:00:00.000Z, but its dates, start and observation give 2026-11-29T00:30:00.000Z',
		]);
	});
});
