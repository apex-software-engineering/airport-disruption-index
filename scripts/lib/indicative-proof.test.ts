/**
 * The both-ways indicative proof end to end: a real archive served by the route handlers, the
 * v1 days settled from it, the indicative day frozen from it, and the v1 prints attested on a git
 * checkout with proofs whose Bitcoin blocks a stubbed explorer answers for.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAttestation, publicationCutoff, serializeAttestation } from '@/lib/index/attestation';
import type { DailyPrint } from '@/lib/index/schemas';
import type { Get } from '@/lib/reproduce';
import { routeGet } from '@/test/api';
import { collectAt } from '@/test/collect';
import { syntheticProof } from '@/test/ots';
import { correctDay, settleDay } from '@/server/archive';
import { collectRound } from '@/server/collector';
import { freezeIndicativeDay } from '@/server/indicative-archive';
import { FileStore } from '@/server/storage';

import type { BranchCheckout } from './attestations';
import { proveIndicativeDay, proveIndicativeDays } from './indicative-proof';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17'),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', {
				noticePublishedAt: '2026-11-01T00:00:00.000Z',
			}),
		],
	};
});

const DAY = '2026-11-20';
const NEXT = '2026-11-21';
const SITE = 'http://test';
/** After both v1 days settled and the indicative day froze. */
const CLOCK = () => new Date('2026-11-22T12:00:00Z');

let root: string;
let store: FileStore;
let checkout: BranchCheckout;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-proof-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
	const directory = await mkdtemp(path.join(tmpdir(), 'adi-proof-attestations-'));
	checkout = { directory, branch: 'attestations' };
	git('init', '--quiet', '--initial-branch=work');
});
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
	await rm(checkout.directory, { recursive: true, force: true });
});

function git(...args: string[]) {
	execFileSync(
		'git',
		[
			'-C',
			checkout.directory,
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t',
			'-c',
			'commit.gpgsign=false',
			...args,
		],
		{ stdio: 'ignore' },
	);
}

/** How a print's attestation is timestamped: in a block before or after its cutoff, or not yet. */
type Stamp = 'timely' | 'late' | 'pending';

/**
 * Commits an attestation of each print, by default proven in a block an hour before its cutoff,
 * and answers for those blocks as the block explorer.
 */
async function attest(prints: readonly (DailyPrint | { print: DailyPrint; stamp: Stamp })[]) {
	const blocks = new Map<number, { merkleRoot: string; time: number }>();
	for (const [index, entry] of prints.entries()) {
		const { print, stamp } = 'print' in entry ? entry : { print: entry, stamp: 'timely' as const };
		const name = `${print.date}.r${print.revision}.json`;
		const file = serializeAttestation(buildAttestation(print, null));
		const height = 100 + index;
		const { proof, merkleRoot } = syntheticProof(
			new TextEncoder().encode(file),
			stamp === 'pending'
				? { kind: 'pending', calendarUrl: 'https://alice.btc.calendar.opentimestamps.org' }
				: { kind: 'bitcoin', height },
		);
		await writeFile(path.join(checkout.directory, name), file);
		await writeFile(path.join(checkout.directory, `${name}.ots`), proof);
		const cutoff = publicationCutoff(print).getTime() / 1000;
		blocks.set(height, { merkleRoot, time: stamp === 'late' ? cutoff + 3600 : cutoff - 3600 });
	}
	git('add', '--all');
	git('commit', '--quiet', '-m', 'attest');
	git('update-ref', 'refs/remotes/origin/attestations', 'HEAD');
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			const height = Number(
				/\/block-height\/(\d+)$/.exec(url)?.[1] ?? /\/block\/h(\d+)$/.exec(url)?.[1],
			);
			const block = blocks.get(height);
			if (block === undefined) return new Response('not found', { status: 404 });
			if (url.includes('/block-height/')) return new Response(`h${height}`);
			return Response.json({ height, merkle_root: block.merkleRoot, timestamp: block.time });
		}),
	);
}

/** Rounds across ET day 2026-11-20 ([05:00Z, next 05:00Z)) in both of its UTC partitions. */
async function collect() {
	for (const at of ['2026-11-20T05:00:03Z', '2026-11-20T23:55:03Z', '2026-11-21T04:55:03Z']) {
		await collectAt(store, at);
	}
}

async function settleBoth() {
	return [(await settleDay(store, DAY)).print, (await settleDay(store, NEXT)).print];
}

const prove = () => proveIndicativeDay(DAY, SITE, checkout, routeGet, CLOCK);
const freeze = () => freezeIndicativeDay(store, DAY, new Date('2026-11-21T05:30:00Z'));

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('expected a value');
	return value;
}

/** An invalid round: the feed answered HTTP 503. */
function collectInvalid(at: string) {
	const fetchedAt = new Date(at);
	return collectRound(
		store,
		async () => ({
			fetchedAt,
			outcome: { kind: 'response', httpStatus: 503, body: new TextEncoder().encode('busy') },
		}),
		() => new Date(fetchedAt.getTime() + 1000),
	);
}

describe('the both-ways indicative proof', () => {
	it('matches when the frozen day lists exactly the in-window receipts its verified v1 days list', async () => {
		await collect();
		const prints = await settleBoth();
		await freezeIndicativeDay(store, DAY, new Date('2026-11-21T05:30:00Z'));
		await attest(prints);
		expect(await prove()).toMatchObject({ kind: 'match' });
	});

	it('is pending, never a match, while a v1 reference is not attested', async () => {
		await collect();
		const [dayPrint] = await settleBoth();
		await freezeIndicativeDay(store, DAY, new Date('2026-11-21T05:30:00Z'));
		await attest(dayPrint === undefined ? [] : [dayPrint]);
		expect(await prove()).toMatchObject({
			kind: 'pending',
			reason: expect.stringContaining(`v1 day ${NEXT}`),
		});
	});

	it('is a mismatch when the indicative day lists a receipt no verified v1 day lists', async () => {
		await collect();
		// 2026-11-20 settles without its 23:55Z receipt; the indicative day, frozen later, has it.
		const receipt = path.join(root, 'rounds/2026-11-20/2026-11-20T23:55Z.json');
		await rename(receipt, `${receipt}.aside`);
		const prints = await settleBoth();
		await rename(`${receipt}.aside`, receipt);
		await freezeIndicativeDay(store, DAY, new Date('2026-11-21T05:30:00Z'));
		await attest(prints);
		expect(await prove()).toMatchObject({
			kind: 'mismatch',
			problems: [
				expect.stringMatching(/^the indicative print of 2026-11-20 lists 2026-11-20T23:55Z /),
			],
		});
	});

	it('includes invalid receipts on both sides (Opus #41 r1, finding 7)', async () => {
		await collect();
		await collectInvalid('2026-11-20T12:00:03Z');
		const prints = await settleBoth();
		await freeze();
		await attest(prints);
		const proof = await prove();
		expect(proof).toMatchObject({ kind: 'match' });
		expect(proof.log.at(-1)).toMatch(/^indicative 2026-11-20: 4 receipts, equal both ways/);
	});

	it('is a mismatch when the indicative day omits a receipt a verified v1 day lists (Opus #41 r1, finding 7)', async () => {
		await collect();
		const prints = await settleBoth();
		const receipt = path.join(root, 'rounds/2026-11-20/2026-11-20T23:55Z.json');
		await rename(receipt, `${receipt}.aside`);
		await freeze();
		await rename(`${receipt}.aside`, receipt);
		await attest(prints);
		expect(await prove()).toMatchObject({
			kind: 'mismatch',
			problems: [
				expect.stringMatching(
					/^v1 day 2026-11-20 r1 lists 2026-11-20T23:55Z \S+, which the indicative print of 2026-11-20 omits$/,
				),
			],
		});
	});

	it('is pending while a reference’s proof has no block, not only while it is unattested (Opus #41 r1, finding 7)', async () => {
		await collect();
		const [dayPrint, nextPrint] = await settleBoth();
		await freeze();
		await attest([required(dayPrint), { print: required(nextPrint), stamp: 'pending' }]);
		expect(await prove()).toMatchObject({
			kind: 'pending',
			reason: expect.stringMatching(
				new RegExp(
					`^v1 day ${NEXT} has no verified revision yet \\(r1 not verified: .* is pending at `,
				),
			),
		});
	});

	describe('checks both references, and a mismatch wins (Sol #41 r1, finding 1; Opus finding 4)', () => {
		it('reports a conflicting D+1 attestation although D is pending', async () => {
			await collect();
			const [dayPrint, nextPrint] = await settleBoth();
			await freeze();
			const conflicting = { ...required(nextPrint), printHash: 'f'.repeat(64) };
			await attest([{ print: required(dayPrint), stamp: 'pending' }, conflicting]);
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [expect.stringMatching(/^r1: /)],
			});
		});
	});

	describe('errors are outcomes, never escapes (Sol #41 r1, finding 2; Opus finding 1)', () => {
		it('is a mismatch when a reference day serves no revisions', async () => {
			await collect();
			const prints = await settleBoth();
			await freeze();
			await attest(prints);
			const get: Get = async (url) => {
				if (!url.endsWith(`/api/v1/days/${NEXT}`)) return routeGet(url);
				const body = await (await routeGet(url)).json();
				return Response.json({ ...body, revisions: [] });
			};
			expect(await proveIndicativeDay(DAY, SITE, checkout, get, CLOCK)).toMatchObject({
				kind: 'mismatch',
			});
		});

		it('cannot verify when the API fails while a reference is read', async () => {
			await collect();
			const prints = await settleBoth();
			await freeze();
			await attest(prints);
			let reads = 0;
			const get: Get = async (url) => {
				// The second read of D+1 (its settled day, after its publication state) fails.
				if (url.endsWith(`/api/v1/days/${NEXT}`) && (reads += 1) === 2)
					return new Response('unavailable', { status: 503 });
				return routeGet(url);
			};
			expect(await proveIndicativeDay(DAY, SITE, checkout, get, CLOCK)).toMatchObject({
				kind: 'cannot_verify',
				reason: expect.stringContaining('HTTP 503'),
			});
		});
	});

	describe('the reference is the latest revision that verifies (design §4; Sol #41 r1, finding 3; Opus finding 3)', () => {
		/** A correction of `print` at `at`, rebuilt from the same receipts. */
		const correctionOf = async (print: DailyPrint, at: string) => {
			return correctDay(
				store,
				print.date,
				{ supersedesPrintHash: print.printHash, reason: 'test correction', windowOverride: null },
				() => new Date(at),
			);
		};

		it('matches on r2 alone when r1 is unattested', async () => {
			await collect();
			const [dayPrint, nextPrint] = await settleBoth();
			const r2 = await correctionOf(required(nextPrint), '2026-11-22T10:00:00Z');
			await freeze();
			await attest([required(dayPrint), r2]);
			const proof = await prove();
			expect(proof).toMatchObject({ kind: 'match' });
			expect(proof.log).toContainEqual(
				expect.stringMatching(
					/^reference v1 day 2026-11-21 r2: .*\(r1 not attested .*; r2 verified\)$/,
				),
			);
		});

		it('matches on a verified r1 while a fresh correction r2 is pending', async () => {
			await collect();
			const [dayPrint, nextPrint] = await settleBoth();
			const r2 = await correctionOf(required(nextPrint), '2026-11-22T10:00:00Z');
			await freeze();
			await attest([required(dayPrint), required(nextPrint), { print: r2, stamp: 'pending' }]);
			const proof = await prove();
			expect(proof).toMatchObject({ kind: 'match' });
			expect(proof.log).toContainEqual(expect.stringMatching(/^reference v1 day 2026-11-21 r1: /));
		});

		it('matches on a timely r2 although r1’s proof came after its cutoff', async () => {
			await collect();
			const [dayPrint, nextPrint] = await settleBoth();
			const r2 = await correctionOf(required(nextPrint), '2026-11-22T10:00:00Z');
			await freeze();
			await attest([required(dayPrint), { print: required(nextPrint), stamp: 'late' }, r2]);
			const proof = await prove();
			expect(proof).toMatchObject({ kind: 'match' });
			expect(proof.log).toContainEqual(
				expect.stringMatching(
					/^reference v1 day 2026-11-21 r2: .*r1 not verified: .*after the publication cutoff/,
				),
			);
		});

		it('is a mismatch when revisions of one v1 day list different receipts', async () => {
			await collect();
			const [dayPrint, nextPrint] = await settleBoth();
			const receipt = path.join(root, 'rounds/2026-11-21/2026-11-21T04:55Z.json');
			await rename(receipt, `${receipt}.aside`);
			const r2 = await correctionOf(required(nextPrint), '2026-11-22T10:00:00Z');
			await rename(`${receipt}.aside`, receipt);
			await freeze();
			await attest([required(dayPrint), required(nextPrint), r2]);
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: ['revisions of v1 day 2026-11-21 disagree: r2 lists other receipts than r1'],
			});
		});
	});

	describe('a day the indicative API does not serve (Sol #41 r1, finding 4; Opus finding 2)', () => {
		it('is a mismatch when its key holds an object that is not its print', async () => {
			await collect();
			const prints = await settleBoth();
			await store.write(
				'indicative/2.0.0/2026-11-20.json',
				new TextEncoder().encode('{"not": "a print"'),
				'application/json',
				{ kind: 'if-absent' },
			);
			await attest(prints);
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [expect.stringContaining('misfiled_indicative')],
			});
		});

		it('cannot verify before its freeze time plus the margin, and is a mismatch after', async () => {
			await collect();
			await attest(await settleBoth());
			const at = (instant: string) =>
				proveIndicativeDay(DAY, SITE, checkout, routeGet, () => new Date(instant));
			expect(await at('2026-11-21T07:29:59Z')).toMatchObject({
				kind: 'cannot_verify',
				reason:
					'indicative day 2026-11-20 is not frozen yet (it freezes at 2026-11-21T05:30:00.000Z)',
			});
			expect(await at('2026-11-21T07:30:00Z')).toMatchObject({
				kind: 'mismatch',
				problems: [
					'indicative day 2026-11-20 is not served at 2026-11-21T07:30:00.000Z, though it freezes at 2026-11-21T05:30:00.000Z',
				],
			});
		});
	});
});

describe('the attest run’s indicative check (Sol #41 r1, finding 2; Opus findings 1 and 7)', () => {
	it('fails only the day whose proof throws, and still proves the rest', async () => {
		await collect();
		await attest(await settleBoth());
		await freeze();
		// Thrown before a promise exists, so no request wrapper turns it into could-not-verify.
		const throwing: Get = (url) => {
			if (url.endsWith('/indicative/days/2026-11-20')) throw new TypeError('boom');
			return routeGet(url);
		};
		const { lines, failures } = await proveIndicativeDays(
			['2026-11-19', DAY, NEXT],
			SITE,
			checkout,
			throwing,
			() => new Date('2026-11-22T06:00:00Z'),
		);
		expect(failures).toBe(1);
		expect(lines).toEqual([
			'2026-11-20: FAILED: indicative proof error: boom',
			'2026-11-21: indicative not checked: indicative day 2026-11-21 is not frozen yet (it freezes at 2026-11-22T05:30:00.000Z)',
		]);
	});

	it('reports a match without failing it', async () => {
		await collect();
		const prints = await settleBoth();
		await freeze();
		await attest(prints);
		const { lines, failures } = await proveIndicativeDays([DAY], SITE, checkout, routeGet, CLOCK);
		expect([failures, lines.at(-1)]).toEqual([0, '2026-11-20: indicative MATCH']);
	});
});
