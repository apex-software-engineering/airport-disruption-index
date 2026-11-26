import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { build } from 'esbuild';

import { sha256Hex } from '@/lib/index/json';
import { METHODOLOGY_V1, METHODOLOGY_V2, RELEASES, release } from '@/lib/index/releases';
import { addDays } from '@/lib/index/time';
import { effectiveAt } from '@/lib/index/calendar';
import type { Methodology } from '@/lib/index/methodology';
import {
	READBACK_ORIGIN,
	noticeHeadline,
	readBackNotice,
	readbackBodyNames,
	readbackRecordName,
	readbackRecordProblems,
	readbackSchema,
	rulesHeading,
	type NoticeReadback,
} from '@/lib/notice-readback';
import type { Get } from '@/lib/reproduce';
import { branchCheckout, type Files } from '@/test/branch-checkout';
import { syntheticProof, syntheticProofs } from '@/test/ots';

import { verifyNotice } from './notice-record';

const NOTICE = { noticePublishedAt: '2026-11-29T00:00:00.000Z' };
const UNANNOUNCED = release(METHODOLOGY_V2, '2027-01-01', NOTICE);
const HEIGHT = 925_000;
const RECORD = readbackRecordName('2.0.0');

/** The production site once `notified`'s notice is out, every response dated `date`. */
function site(date: string, notified: Methodology): Get {
	const headers = { Date: date, 'X-Deployed-Commit': 'a'.repeat(40) };
	const html = (body: string) =>
		new Response(`<html><body>${body}</body></html>`, {
			headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
		});
	return async (url) => {
		if (url === `${READBACK_ORIGIN}/incidents`)
			return html(`<p>${noticeHeadline(notified)}. Hash ${notified.parameterHash}.</p>`);
		if (url === `${READBACK_ORIGIN}/methodology`) return html(`<h3>${rulesHeading(notified)}</h3>`);
		return Response.json(
			{ upcoming: { version: '2.0.0', parameterHash: notified.parameterHash } },
			{ headers },
		);
	};
}

/** A readback run at `at`, as the workflow writes it: the record and its three bodies. */
async function readback(
	at: string,
	notified: Methodology = UNANNOUNCED,
): Promise<{ record: NoticeReadback; files: Files }> {
	const instant = new Date(at);
	const result = await readBackNotice(
		READBACK_ORIGIN,
		notified,
		{ id: 7, attempt: 1, startedAt: instant },
		() => instant,
		site(instant.toUTCString(), notified),
	);
	if (result.kind !== 'recorded')
		throw new Error(`expected a record: ${result.reasons.join('; ')}`);
	return { record: result.record, files: filesOf(result.record, result.bodies) };
}

/** The record (serialized as the CLI writes it) and its bodies, as committed. */
function filesOf(record: NoticeReadback, bodies: { name: string; bytes: Uint8Array }[]): Files {
	const files: Files = { [RECORD]: `${JSON.stringify(record, null, '\t')}\n` };
	for (const { name, bytes } of bodies) files[`notices/${name}`] = bytes;
	return files;
}

/**
 * v1 and v2 with step 2's values: v1 ends the day before v2 (2027-01-01 unless `effectiveFrom`),
 * v2 announced at N with proof time B in block HEIGHT (unless `height`).
 */
function registry(
	announcedAt: string | null,
	announcedProofAt: string | null,
	{ effectiveFrom = '2027-01-01', height = announcedProofAt === null ? null : HEIGHT } = {},
): Methodology[] {
	return [
		release(METHODOLOGY_V1, '2026-11-17', { effectiveUntil: addDays(effectiveFrom, -1) }),
		release(METHODOLOGY_V2, effectiveFrom, {
			...NOTICE,
			announcedAt,
			announcedProofAt,
			announcedProofHeight: height,
		}),
	];
}

/** A record and bodies, by default a readback at `at`. */
type Readback = { record: NoticeReadback; files: Files };

/**
 * The attestations branch with `readback` and its proof, reaching a block at `proofAt` (null:
 * still pending), in one commit.
 */
function published({ record, files }: Readback, proofAt: string | null) {
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

/** The branch after a readback at `at` whose proof reaches a block at `proofAt`. */
async function readBackAndPublish(at: string, proofAt: string | null) {
	return published(await readback(at), proofAt);
}

async function verify(
	branch: ReturnType<typeof branchCheckout>,
	releases: Methodology[],
	blockAt: Parameters<typeof verifyNotice>[3],
) {
	return verifyNotice(branch.checkout, '2.0.0', releases, blockAt);
}

/** `readback` with its bodies replaced, each rehashed in the record: a hand-written record. */
function withBodies(
	{ record }: Readback,
	bodies: { incidents: string; rules: string; methodology: string },
): Readback {
	const names = readbackBodyNames('2.0.0');
	const replaced = [
		{ name: names.incidents, bytes: new TextEncoder().encode(bodies.incidents) },
		{ name: names.rules, bytes: new TextEncoder().encode(bodies.rules) },
		{ name: names.methodology, bytes: new TextEncoder().encode(bodies.methodology) },
	];
	const rehashed: NoticeReadback = {
		...record,
		responses: record.responses.map((response, index) => ({
			...response,
			bodySha256: sha256Hex(replaced[index]?.bytes ?? new Uint8Array()),
		})),
	};
	return { record: rehashed, files: filesOf(rehashed, replaced) };
}

describe('the step-2 notice check', () => {
	it('verifies N and B from the record and its proof when B is after N', async () => {
		const { branch, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
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
			proofHeight: HEIGHT,
			bound: '2026-12-29T01:10:00.000Z',
		});
	});

	it('uses N for the bound when the block time B is before it', async () => {
		const { branch, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T00:05:00Z',
		);
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T00:05:00.000Z'),
				blockAt,
			),
		).toMatchObject({ kind: 'verified', bound: '2026-12-29T00:20:05.000Z' });
	});

	it('holds the bound exactly: max(N, B) up to 2026-12-02T00:00Z, and not a second later', async () => {
		const at = await readBackAndPublish('2026-12-01T23:00:00Z', '2026-12-02T00:00:00Z');
		expect(
			await verify(
				at.branch,
				registry('2026-12-01T23:00:00.000Z', '2026-12-02T00:00:00.000Z'),
				at.blockAt,
			),
		).toMatchObject({ kind: 'verified', bound: '2027-01-01T00:00:00.000Z' });
		const late = await readBackAndPublish('2026-12-02T00:00:01Z', '2026-12-01T23:50:00Z');
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
		const { branch, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:00:00.000Z', '2026-11-29T01:00:00.000Z'),
				blockAt,
			),
		).toEqual({
			kind: 'invalid',
			problems: [
				"announcedAt is 2026-11-29T00:00:00.000Z; it must be the record's N, 2026-11-29T00:20:05.000Z (an ISO instant with milliseconds, as the record writes it (e.g. 2026-11-29T00:20:05.000Z))",
				`announcedProofHeight and announcedProofAt are ${HEIGHT} and 2026-11-29T01:00:00.000Z; they must be Bitcoin block ${HEIGHT} and its time 2026-11-29T01:10:00.000Z (an ISO instant with milliseconds, as the record writes it (e.g. 2026-11-29T00:20:05.000Z))`,
			],
		});
	});

	it('reads the record and its bodies as first committed, flagging a later rewrite', async () => {
		const { branch, files, blockAt } = await readBackAndPublish(
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
		const { files, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
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
		const { branch, blockAt } = await readBackAndPublish('2026-11-29T00:20:05Z', null);
		expect(await verify(branch, registry('2026-11-29T00:20:05.000Z', null), blockAt)).toEqual({
			kind: 'pending',
			calendars: ['https://alice.btc.calendar.opentimestamps.org'],
		});
	});

	it('refuses a proof that commits to other bytes, and a missing proof or record', async () => {
		const { branch, files, blockAt } = await readBackAndPublish(
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

	it('has nothing to check until the release is announced, and refuses B or its block without N', async () => {
		const branch = branchCheckout();
		const unused = async () => {
			throw new Error('no block is read');
		};
		expect(await verify(branch, registry(null, null), unused)).toEqual({ kind: 'not_announced' });
		expect(await verify(branch, registry(null, '2026-11-29T01:10:00.000Z'), unused)).toEqual({
			kind: 'invalid',
			problems: ['2.0.0 has a proof time or height without N'],
		});
		expect(await verify(branch, registry(null, null, { height: HEIGHT }), unused)).toEqual({
			kind: 'invalid',
			problems: ['2.0.0 has a proof time or height without N'],
		});
	});
});

describe('the saved pages must show the notice (Sol #43 r1, finding 1; Opus finding 1)', () => {
	const values = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z');

	it('refuses a hand-written record whose pages never showed the notice', async () => {
		const nothing = '<p>nothing about any notice</p>';
		const forged = withBodies(await readback('2026-11-29T00:20:05Z'), {
			incidents: nothing,
			rules: nothing,
			methodology: nothing,
		});
		const { branch, blockAt } = published(forged, '2026-11-29T01:10:00Z');
		expect(await verify(branch, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				`${READBACK_ORIGIN}/incidents does not show "${noticeHeadline(UNANNOUNCED)}"`,
				`${READBACK_ORIGIN}/incidents does not show "${UNANNOUNCED.parameterHash}"`,
				`${READBACK_ORIGIN}/methodology does not show "Settlement rules, v2.0.0"`,
				`${READBACK_ORIGIN}/api/v1/methodology has no upcoming block for 2.0.0`,
			],
		});
	});

	it('refuses a notice of a later effective day than the registry’s', async () => {
		const january2 = release(METHODOLOGY_V2, '2027-01-02', NOTICE);
		const { branch, blockAt } = published(
			await readback('2026-11-29T00:20:05Z', january2),
			'2026-11-29T01:10:00Z',
		);
		expect(await verify(branch, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				`${READBACK_ORIGIN}/incidents does not show "${noticeHeadline(UNANNOUNCED)}": it states effective ET day 2027-01-02`,
			],
		});
	});

	it('keeps a record through a postponement: the day it announced may be earlier than the registry’s', async () => {
		const { branch, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
		const postponed = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z', {
			effectiveFrom: '2027-01-08',
		});
		expect(await verify(branch, postponed, blockAt)).toMatchObject({ kind: 'verified' });
	});

	it('refuses a site that states the release under another hash', async () => {
		const read = await readback('2026-11-29T00:20:05Z');
		const other = JSON.stringify({ upcoming: { version: '2.0.0', parameterHash: 'c'.repeat(64) } });
		const { branch, blockAt } = published(
			withBodies(read, {
				incidents: `<p>${noticeHeadline(UNANNOUNCED)} ${UNANNOUNCED.parameterHash}</p>`,
				rules: '<h3>Settlement rules, v2.0.0</h3>',
				methodology: other,
			}),
			'2026-11-29T01:10:00Z',
		);
		expect(await verify(branch, values, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				`${READBACK_ORIGIN}/api/v1/methodology states 2.0.0 with parameter hash "${'c'.repeat(64)}", not ${UNANNOUNCED.parameterHash}`,
			],
		});
	});
});

describe('B is the pinned block’s time (Opus #43 r1, finding 3)', () => {
	it('refuses a pin on another block, and names the block to pin', async () => {
		const { branch, blockAt } = await readBackAndPublish(
			'2026-11-29T00:20:05Z',
			'2026-11-29T01:10:00Z',
		);
		const pinnedElsewhere = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z', {
			height: HEIGHT - 1,
		});
		expect(await verify(branch, pinnedElsewhere, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				expect.stringMatching(
					new RegExp(
						`^announcedProofHeight is ${HEIGHT - 1}, but the proof first reached Bitcoin block ${HEIGHT} `,
					),
				),
			],
		});
		const unpinned = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z', {
			height: null,
		});
		expect(await verify(branch, unpinned, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				expect.stringMatching(
					new RegExp(
						`^announcedProofHeight and announcedProofAt are null and 2026-11-29T01:10:00.000Z; they must be Bitcoin block ${HEIGHT} and its time`,
					),
				),
			],
		});
	});
});

describe('B is the block the proof first reached (Sol #43 r2, finding 4)', () => {
	/** A record whose proof reaches block HEIGHT at 01:10Z and HEIGHT + 1 at the earlier 01:00Z. */
	async function twoBlocks() {
		const { files } = await readback('2026-11-29T00:20:05Z');
		const bytes = new TextEncoder().encode(String(files[RECORD]));
		const both = syntheticProofs(bytes, [
			{ kind: 'bitcoin', height: HEIGHT },
			{ kind: 'bitcoin', height: HEIGHT + 1 },
		]);
		const times = new Map([
			[HEIGHT, '2026-11-29T01:10:00.000Z'],
			[HEIGHT + 1, '2026-11-29T01:00:00.000Z'],
		]);
		const blockAt = async (height: number) => ({
			merkleRoot: both.merkleRoot,
			time: new Date(times.get(height) ?? ''),
		});
		return { files, bytes, both, blockAt };
	}

	it('refuses a pin on a later block whose header time is earlier', async () => {
		const { files, both, blockAt } = await twoBlocks();
		const branch = branchCheckout();
		branch.commit({ ...files, [`${RECORD}.ots`]: both.proof });
		const later = registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:00:00.000Z', {
			height: HEIGHT + 1,
		});
		expect(await verify(branch, later, blockAt)).toEqual({
			kind: 'invalid',
			problems: [
				expect.stringMatching(
					new RegExp(
						`^announcedProofHeight is ${HEIGHT + 1}, but the proof first reached Bitcoin block ${HEIGHT} \\(commit [0-9a-f]{40}\\): B is that block's time$`,
					),
				),
				expect.stringMatching(
					new RegExp(
						`^announcedProofHeight and announcedProofAt .* must be Bitcoin block ${HEIGHT} and its time 2026-11-29T01:10:00.000Z `,
					),
				),
			],
		});
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:10:00.000Z'),
				blockAt,
			),
		).toMatchObject({ kind: 'verified', proofHeight: HEIGHT });
	});

	it('keeps the pin when a later upgrade adds an earlier block', async () => {
		const { files, bytes, both, blockAt } = await twoBlocks();
		const branch = branchCheckout();
		const first = syntheticProofs(bytes, [{ kind: 'bitcoin', height: HEIGHT + 1 }]);
		branch.commit({ ...files, [`${RECORD}.ots`]: first.proof });
		branch.commit({ [`${RECORD}.ots`]: both.proof });
		expect(
			await verify(
				branch,
				registry('2026-11-29T00:20:05.000Z', '2026-11-29T01:00:00.000Z', { height: HEIGHT + 1 }),
				blockAt,
			),
		).toMatchObject({ kind: 'verified', proofHeight: HEIGHT + 1 });
	});
});

describe('the release is the registry’s own (Sol #43 r1, finding 4)', () => {
	it('refuses an unregistered release, and never takes a copy’s own boundary as the cutover', async () => {
		const branch = branchCheckout();
		const unused = async () => {
			throw new Error('no block is read');
		};
		expect(await verifyNotice(branch.checkout, '9.9.9', RELEASES, unused)).toEqual({
			kind: 'invalid',
			problems: ['no registered release is 9.9.9'],
		});
		const [, v2] = RELEASES;
		if (v2 === undefined) throw new Error('expected v2');
		expect(() => effectiveAt({ ...v2 }, RELEASES)).toThrow(/is not this registry's release/);
	});
});

describe('the CI step (Opus #43 r1, finding 4; Sol r2, finding 1; Opus r2, finding 2)', () => {
	const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
	const gate = new RegExp(/grep -qE '([^']+)'/.exec(ci)?.[1] ?? '^$');

	it('verifies every later release', () => {
		for (const later of RELEASES.slice(1)) {
			expect(ci).toContain(`npm run -s verify-notice -- ${later.parameters.version} `);
		}
	});

	it('runs it for any change to a file the verifier is built from, and the config around it', async () => {
		const { metafile } = await build({
			entryPoints: ['scripts/verify-notice.ts'],
			bundle: true,
			write: false,
			metafile: true,
			platform: 'node',
			format: 'esm',
			packages: 'external',
			logLevel: 'silent',
		});
		const sources = Object.keys(metafile.inputs);
		expect(sources).toContain('scripts/lib/notice-record.ts');
		expect(sources).toContain('src/lib/index/releases.ts');
		for (const path of [
			...sources,
			'tsconfig.json',
			'.nvmrc',
			'.github/workflows/ci.yml',
			'.github/workflows/notice-readback.yml',
			'.github/workflows/attest.yml',
			'package.json',
			'package-lock.json',
		]) {
			expect(gate.test(path), path).toBe(true);
		}
		expect(gate.test('docs/methodology.md')).toBe(false);
	});

	it('counts both paths of a rename, and skips only a PR into main', () => {
		expect(ci).toContain('git diff --name-only --no-renames "$BASE" HEAD');
		expect(ci).toContain('if [[ "$BASE_REF" == main ]]; then');
	});
});

describe('replaying a readback record', () => {
	it('refuses clock readings that run backwards (Sol #43 r1, finding 2)', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		const [first, second, third] = record.responses;
		if (first === undefined || second === undefined || third === undefined)
			throw new Error('expected three responses');
		const late: NoticeReadback = {
			...record,
			run: { ...record.run, observedAt: '2026-11-29T00:20:04.000Z' },
			responses: [first, { ...second, requestedAt: '2026-11-29T00:20:04.000Z' }, third],
			noticeAt: '2026-11-29T00:20:05.000Z',
		};
		expect(readbackRecordProblems(late, UNANNOUNCED, READBACK_ORIGIN)).toEqual([
			'the run observed (2026-11-29T00:20:04.000Z) before it started (2026-11-29T00:20:05.000Z)',
			"response 1 was received (2026-11-29T00:20:05.000Z) after the run's observation (2026-11-29T00:20:04.000Z)",
			'response 2 was requested (2026-11-29T00:20:04.000Z) before response 1 was received (2026-11-29T00:20:05.000Z)',
			"response 2 was received (2026-11-29T00:20:05.000Z) after the run's observation (2026-11-29T00:20:04.000Z)",
			"response 3 was received (2026-11-29T00:20:05.000Z) after the run's observation (2026-11-29T00:20:04.000Z)",
		]);
	});

	it('accepts only millisecond instants, which parse to themselves (Sol #43 r1, finding 2)', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		expect(readbackSchema.safeParse(record).success).toBe(true);
		for (const noticeAt of [
			'2026-11-29T00:20:05.0001Z',
			'2026-11-29T00:20:05Z',
			'2026-11-29T00:20:05.000+00:00',
		]) {
			expect(readbackSchema.safeParse({ ...record, noticeAt }).success, noticeAt).toBe(false);
		}
	});

	it('refuses an N before the notice instant (Sol #43 r1, finding 1)', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		const early = release(METHODOLOGY_V2, '2027-01-01', {
			noticePublishedAt: '2026-11-30T00:00:00.000Z',
		});
		expect(readbackRecordProblems(record, early, READBACK_ORIGIN)).toEqual([
			'N 2026-11-29T00:20:05.000Z is before the notice instant 2026-11-30T00:00:00.000Z',
		]);
	});

	it('finds nothing wrong with a record as the readback writes it', async () => {
		const { record } = await readback('2026-11-29T00:20:05Z');
		expect(readbackRecordProblems(record, UNANNOUNCED, READBACK_ORIGIN)).toEqual([]);
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
		expect(readbackRecordProblems(altered, UNANNOUNCED, READBACK_ORIGIN)).toEqual([
			`the record is for "2.0.0" with parameter hash "${'b'.repeat(64)}", not 2.0.0 with ${UNANNOUNCED.parameterHash}`,
			`response 1 is from "https://elsewhere.test/incidents", not ${READBACK_ORIGIN}/incidents`,
			'response 1 states Date "Sun, 29 Nov 2026 00:30:00 GMT", outside the run\'s observation of it (2026-11-29T00:20:05.000Z to 2026-11-29T00:20:05.000Z)',
			'the record states N 2026-11-29T00:00:00.000Z, but its dates, start and observation give 2026-11-29T00:30:00.000Z',
		]);
	});
});
