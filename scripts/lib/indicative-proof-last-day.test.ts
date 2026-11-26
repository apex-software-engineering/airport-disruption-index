/**
 * The E−1 branch of the indicative proof and the D8 gap pin (design §4, test 12), on the activated
 * cutover: v1 ends with UTC day 2026-12-31, v2 takes effect at 2027-01-01T00:00Z, and ET day
 * 2026-12-31, the last indicative day, spans v1 UTC day 2026-12-31 (228 slots) and the transition
 * interval [2027-01-01T00:00Z, 05:00Z) (60 slots). A real archive is served by the route handlers;
 * only the registry, the git checkout and the block explorer are test doubles.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAttestation, publicationCutoff, serializeAttestation } from '@/lib/index/attestation';
import { activatedCutoverInto, type Cutover } from '@/lib/index/calendar';
import { release, METHODOLOGY_V1, METHODOLOGY_V2, RELEASES } from '@/lib/index/releases';
import type { DailyPrint } from '@/lib/index/schemas';
import type { Get } from '@/lib/reproduce';
import { routeGet } from '@/test/api';
import { collectAt } from '@/test/collect';
import { syntheticProof } from '@/test/ots';
import { settleDay } from '@/server/archive';
import { freezeIndicativeDay } from '@/server/indicative-archive';
import { FileStore } from '@/server/storage';

import type { BranchCheckout } from './attestations';
import {
	pinGap,
	proveIndicativeDay,
	proveIndicativeDays,
	type IndicativeProof,
} from './indicative-proof';
import {
	readGapReceipts,
	serializeTransitionPin,
	transitionPinCutoff,
	transitionPinName,
	writeTransitionPin,
	type GapRound,
} from './transition-pin';

vi.mock('@/lib/index/releases', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/index/releases')>();
	return {
		...actual,
		RELEASES: [
			actual.release(actual.METHODOLOGY_V1, '2026-11-17', { effectiveUntil: '2026-12-31' }),
			actual.release(actual.METHODOLOGY_V2, '2027-01-01', {
				announcedAt: '2026-11-25T15:00:00.000Z',
				noticePublishedAt: '2026-11-01T00:00:00.000Z',
			}),
		],
	};
});

const LAST = '2026-12-31';
const SITE = 'http://test';
/** After v1 day 2026-12-31 settled and E−1 froze (05:30Z), before the pin's cutoff (next 05:00Z). */
const CLOCK = () => new Date('2027-01-01T12:00:00Z');

let root: string;
let store: FileStore;
let checkout: BranchCheckout;
let blocks: Map<number, { merkleRoot: string; time: number }>;

function cutover(): Cutover {
	const v2 = RELEASES[1];
	const found = v2 === undefined ? null : activatedCutoverInto(v2);
	if (found === null) throw new Error('the test registry has an activated cutover');
	return found;
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'adi-last-day-'));
	store = new FileStore(root);
	vi.stubEnv('ADI_DATA_DIR', root);
	const directory = await mkdtemp(path.join(tmpdir(), 'adi-last-day-attestations-'));
	checkout = { directory, branch: 'attestations' };
	git('init', '--quiet', '--initial-branch=work');
	blocks = new Map();
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

/** How a file is timestamped: in a block before or after its cutoff, or not yet. */
type Stamp = 'timely' | 'late' | 'pending';

/** Writes `file` at `name` with a proof stamped as asked against `cutoff`, uncommitted. */
async function stampFile(name: string, file: string, cutoff: Date, stamp: Stamp) {
	const height = 100 + blocks.size;
	const { proof, merkleRoot } = syntheticProof(
		new TextEncoder().encode(file),
		stamp === 'pending'
			? { kind: 'pending', calendarUrl: 'https://alice.btc.calendar.opentimestamps.org' }
			: { kind: 'bitcoin', height },
	);
	await mkdir(path.dirname(path.join(checkout.directory, name)), { recursive: true });
	await writeFile(path.join(checkout.directory, name), file);
	await writeFile(path.join(checkout.directory, `${name}.ots`), proof);
	const seconds = cutoff.getTime() / 1000;
	blocks.set(height, { merkleRoot, time: stamp === 'late' ? seconds + 3600 : seconds - 3600 });
}

function commit(message: string) {
	git('add', '--all');
	git('commit', '--quiet', '--allow-empty', '-m', message);
	git('update-ref', 'refs/remotes/origin/attestations', 'HEAD');
}

/** Commits a timely attestation of each print. */
async function attest(prints: readonly DailyPrint[]) {
	for (const print of prints) {
		await stampFile(
			`${print.date}.r${print.revision}.json`,
			serializeAttestation(buildAttestation(print, null)),
			publicationCutoff(print),
			'timely',
		);
	}
	commit('attest');
}

/** Commits a gap pin of `rounds` (by default as the writer would write it), stamped as asked. */
async function pin(rounds: readonly GapRound[], stamp: Stamp = 'timely', file?: string) {
	const name = transitionPinName(cutover());
	await stampFile(
		name,
		file ?? serializeTransitionPin(cutover(), rounds),
		transitionPinCutoff(cutover()),
		stamp,
	);
	commit('pin');
}

/** Every gap slot (60), plus rounds either side of ET day 2026-12-31 in both UTC partitions. */
async function collect() {
	for (const at of [
		'2026-12-31T04:55:03Z', // v1 day, before the ET day: in no indicative comparison
		'2026-12-31T05:00:03Z',
		'2026-12-31T23:55:03Z',
		'2027-01-01T05:00:03Z', // the first v2 ET day: outside E−1
	]) {
		await collectAt(store, at);
	}
	for (let slot = 0; slot < 60; slot += 1) {
		const at = new Date(Date.parse('2027-01-01T00:00:03Z') + slot * 300_000);
		await collectAt(store, at.toISOString());
	}
}

const settle = async () => (await settleDay(store, LAST)).print;
const freeze = async () =>
	(await freezeIndicativeDay(store, LAST, new Date('2027-01-01T05:30:00Z'))).print;
const prove = (get: Get = routeGet) => proveIndicativeDay(LAST, SITE, checkout, get, CLOCK);

/** The gap rounds the frozen print lists, as the pin holds them. */
async function gapRounds(): Promise<GapRound[]> {
	const proof = await (async () => {
		await attest([await settle()]);
		await freeze();
		return prove();
	})();
	if (proof.kind !== 'partial') throw new Error(`expected PARTIAL, got ${proof.kind}`);
	return proof.unpinned;
}

function expectKind(proof: IndicativeProof, kind: IndicativeProof['kind']) {
	expect(proof.kind, JSON.stringify(proof, null, 1)).toBe(kind);
}

describe('the E−1 branch (design §4, test 12)', () => {
	it('is a mismatch (exit 1) when the rebuild differs from the published print', async () => {
		await collect();
		await attest([await settle()]);
		await freeze();
		const tampering: Get = async (url) => {
			if (!url.endsWith(`/api/v1/indicative/days/${LAST}`)) return routeGet(url);
			const body = await (await routeGet(url)).json();
			const [round, ...rounds] = body.print.rounds;
			return Response.json({
				...body,
				print: { ...body.print, rounds: [...rounds, round] },
			});
		};
		expectKind(await prove(tampering), 'mismatch');
	});

	it('is pending (exit 4) while UTC E−1 is not attested, and never waits for a second reference', async () => {
		await collect();
		await settle();
		await freeze();
		commit('empty');
		const proof = await prove();
		expect(proof).toMatchObject({
			kind: 'pending',
			reason: expect.stringContaining(`v1 day ${LAST} has no verified revision yet`),
		});
		// Only UTC E−1 is a reference: 2027-01-01 is no v1 day and is never asked for.
		const asked: string[] = [];
		await prove(async (url) => {
			asked.push(url);
			return routeGet(url);
		});
		expect(asked.filter((url) => url.includes('/api/v1/days/'))).toEqual([
			`${SITE}/api/v1/days/${LAST}`,
			`${SITE}/api/v1/days/${LAST}`,
		]);
	});

	describe('a covered-slot difference is a mismatch whatever the pin (a pin never masks it)', () => {
		/** v1 day 2026-12-31 settles without its 23:55Z receipt; the frozen ET day has it. */
		async function divergent() {
			await collect();
			const receipt = path.join(root, 'rounds/2026-12-31/2026-12-31T23:55Z.json');
			await rename(receipt, `${receipt}.aside`);
			const print = await settle();
			await rename(`${receipt}.aside`, receipt);
			await attest([print]);
			const frozen = await freeze();
			return frozen.rounds.filter((round) => round.roundId.startsWith('2027-01-01T0'));
		}

		it('with the pin absent', async () => {
			await divergent();
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [
					expect.stringMatching(/^the indicative print of 2026-12-31 lists 2026-12-31T23:55Z /),
				],
			});
		});

		it('with the pin pending', async () => {
			const rounds = await divergent();
			await pin(
				rounds.filter((round) => round.roundId < '2027-01-01T05:00Z'),
				'pending',
			);
			expectKind(await prove(), 'mismatch');
		});
	});

	it('is partial (exit 5) with no pin, listing exactly the 60 gap slots', async () => {
		await collect();
		const rounds = await gapRounds();
		expect(rounds).toHaveLength(60);
		expect(rounds[0]?.roundId).toBe('2027-01-01T00:00Z');
		expect(rounds.at(-1)?.roundId).toBe('2027-01-01T04:55Z');
	});

	it('is pending (exit 4) while the pin’s proof has no block, after the covered slots compared equal', async () => {
		await collect();
		await pin(await gapRounds(), 'pending');
		expect(await prove()).toMatchObject({
			kind: 'pending',
			reason: expect.stringMatching(/^the covered slots are equal both ways, but the gap pin/),
		});
	});

	describe('a bad pin is a mismatch (exit 1)', () => {
		it('when its proof reaches a block after the cutoff', async () => {
			await collect();
			await pin(await gapRounds(), 'late');
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [expect.stringMatching(/after the publication cutoff 2027-01-02T05:00:00.000Z$/)],
			});
		});

		it('when its proof commits to other bytes', async () => {
			await collect();
			const rounds = await gapRounds();
			await pin(rounds);
			const name = transitionPinName(cutover());
			const other = path.join(checkout.directory, 'other.json');
			await writeFile(other, 'other');
			const { proof } = syntheticProof(new TextEncoder().encode('other'), {
				kind: 'bitcoin',
				height: 999,
			});
			await writeFile(path.join(checkout.directory, `${name}.ots`), proof);
			await rm(other);
			commit('rewrite the proof');
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [expect.stringContaining('does not commit to this attestation file')],
			});
		});

		it('when it pins another window', async () => {
			await collect();
			const rounds = await gapRounds();
			const file = serializeTransitionPin(cutover(), rounds).replace(
				'"start": "2027-01-01T00:00:00.000Z"',
				'"start": "2027-01-01T00:05:00.000Z"',
			);
			await pin(rounds, 'timely', file);
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [
					expect.stringMatching(/pins \[2027-01-01T00:05:00.000Z, .*not the transition interval/),
				],
			});
		});

		it('when its bytes were rewritten after they were first committed', async () => {
			await collect();
			const rounds = await gapRounds();
			await pin(rounds);
			// The rewrite carries a fresh, timely proof: only the branch history exposes it.
			await pin(rounds.slice(1));
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [
					expect.stringMatching(/^gap pin: transition\/2027-01-01\.json was modified in /),
				],
			});
		});

		it('when a gap receipt differs from the one the print lists', async () => {
			await collect();
			const rounds = await gapRounds();
			const [first, ...rest] = rounds;
			if (first === undefined) throw new Error('no gap round');
			await pin([{ ...first, receiptHash: 'f'.repeat(64) }, ...rest]);
			expect(await prove()).toMatchObject({
				kind: 'mismatch',
				problems: [
					`the gap pin lists 2027-01-01T00:00Z ${'f'.repeat(64)} ${first.status}, which the indicative print of 2026-12-31 omits`,
					`the indicative print of 2026-12-31 lists 2027-01-01T00:00Z ${first.receiptHash} ${first.status}, which the gap pin does not`,
				],
			});
		});
	});

	it('matches (exit 0) with a timely pin whose gap receipts equal the print’s', async () => {
		await collect();
		await pin(await gapRounds());
		const proof = await prove();
		expectKind(proof, 'match');
		expect(proof.log.at(-1)).toBe(
			'indicative 2026-12-31: 60 gap receipts, equal both ways to the gap pin; all 62 receipts proved',
		);
	});
});

/** The API as a deployment with step 2 live serves it: collecting under `served` (v2 by default). */
function deployment(served: 'v2' | 'v1' = 'v2'): Get {
	return async (url) => {
		if (!url.endsWith('/api/v1/methodology')) return routeGet(url);
		const release = served === 'v2' ? cutover().to : RELEASES[0];
		return Response.json({
			version: release?.parameters.version,
			parameterHash: release?.parameterHash,
		});
	};
}

const pinAt = (at: string, get: Get = deployment()) =>
	pinGap(cutover(), SITE, checkout, get, () => new Date(at));

describe('writing the gap pin (pinGap)', () => {
	it('writes it at the first run after E−1 froze, while UTC E−1’s proof is still pending (Sol S2, Opus O2)', async () => {
		await collect();
		await settle();
		await freeze();
		commit('nothing attested yet');
		const written = await pinAt('2027-01-01T05:45:00Z');
		expect(written).toEqual({
			line: expect.stringMatching(
				/^2026-12-31: wrote gap pin .*transition\/2027-01-01\.json \(60 receipts\)$/,
			),
			failed: false,
		});
		const bytes = await readFile(
			path.join(checkout.directory, 'transition/2027-01-01.json'),
			'utf8',
		);
		expect(JSON.parse(bytes)).toMatchObject({
			release: { methodologyVersion: '2.0.0' },
			window: { start: '2027-01-01T00:00:00.000Z', end: '2027-01-01T05:00:00.000Z' },
		});
		expect(JSON.parse(bytes).rounds).toHaveLength(60);
	});

	it('round-trips: the pin it writes proves MATCH once stamped', async () => {
		await collect();
		await attest([await settle()]);
		await freeze();
		await pinAt('2027-01-01T05:45:00Z');
		const name = transitionPinName(cutover());
		const bytes = await readFile(path.join(checkout.directory, name), 'utf8');
		await pin([], 'timely', bytes);
		expectKind(await prove(), 'match');
		expect(await pinAt('2027-01-01T06:45:00Z')).toEqual({
			line: `2026-12-31: gap pin ${name} is on the branch`,
			failed: false,
		});
	});

	it('is not due before E−1 freezes, and writes nothing', async () => {
		commit('empty');
		expect(await pinAt('2027-01-01T05:29:59Z')).toEqual({
			line: '2026-12-31: gap pin transition/2027-01-01.json is due from 2027-01-01T05:30:00.000Z',
			failed: false,
		});
	});

	it('fails, and writes nothing, while the deployment is not collecting under v2 (Sol S3)', async () => {
		await collect();
		await settle();
		await freeze();
		commit('empty');
		const run = await pinAt('2027-01-01T05:45:00Z', deployment('v1'));
		expect(run.failed).toBe(true);
		expect(run.line).toMatch(/collects under 1\.0\.0 .*not 2\.0\.0: the cutover is not live there/);
		expect(run.line).toMatch(
			/Recover by dispatching the Attest workflow with date 2026-12-31 before 2027-01-01T17:00:00.000Z$/,
		);
		await expect(
			readFile(path.join(checkout.directory, 'transition/2027-01-01.json')),
		).rejects.toThrow(/ENOENT/);
	});

	it('fails, and writes nothing, when the archive holds a gap receipt the print omits (Sol S1)', async () => {
		await collect();
		await settle();
		const receipt = path.join(root, 'rounds/2027-01-01/2027-01-01T00:00Z.json');
		await rename(receipt, `${receipt}.aside`);
		await freeze();
		await rename(`${receipt}.aside`, receipt);
		commit('empty');
		const run = await pinAt('2027-01-01T05:45:00Z');
		expect(run.failed).toBe(true);
		expect(run.line).toMatch(
			/the archive serves 2027-01-01T00:00Z \S+ valid, which the indicative print of 2026-12-31 omits/,
		);
	});

	it('fails loudly once no pin can be written any more, and the run keeps failing (Sol S2, Opus O3)', async () => {
		commit('empty');
		const run = await pinAt('2027-01-01T17:00:00Z');
		expect(run).toEqual({
			line: expect.stringMatching(
				/^2026-12-31: FAILED: gap pin transition\/2027-01-01\.json is not on the branch, and no pin is written after 2027-01-01T17:00:00.000Z/,
			),
			failed: true,
		});
	});

	it('the writer refuses before E−1 froze, in the 12 hours before the cutoff, and over an existing file', async () => {
		const write = (at: string) =>
			writeTransitionPin(checkout.directory, cutover(), [], new Date(at));
		await expect(write('2027-01-01T05:29:59Z')).rejects.toThrow(
			/written from 2027-01-01T05:30:00.000Z/,
		);
		await expect(write('2027-01-01T17:00:00Z')).rejects.toThrow(/12 hours before its cutoff/);
		await write('2027-01-01T05:45:00Z');
		await expect(write('2027-01-01T06:45:00Z')).rejects.toThrow(/EEXIST/);
	});

	it('the attest loop reports PARTIAL without failing, and fails a late pin', async () => {
		await collect();
		await attest([await settle()]);
		await freeze();
		const run = () => proveIndicativeDays([LAST], SITE, checkout, routeGet, CLOCK);
		const partial = await run();
		expect(partial.failures).toBe(0);
		expect(partial.lines.at(-1)).toBe(
			'2026-12-31: indicative PARTIAL: the covered slots are equal both ways; 60 gap receipts are unpinned',
		);
		await pin(await gapRounds(), 'late');
		expect((await run()).failures).toBe(1);
	});
});

describe('the pin is derived from the activated cutover, never a constant', () => {
	const v1 = (effectiveUntil: string | null) =>
		release(METHODOLOGY_V1, '2026-11-17', effectiveUntil === null ? {} : { effectiveUntil });
	const v2 = (effectiveFrom: string, announcedAt: string | null) =>
		release(METHODOLOGY_V2, effectiveFrom, announcedAt === null ? {} : { announcedAt });

	it('moves its path and window with a postponed effectiveFrom', () => {
		const releases = [v1('2027-01-07'), v2('2027-01-08', '2026-12-01T00:00:00.000Z')];
		const [, next] = releases;
		const postponed = next === undefined ? null : activatedCutoverInto(next, releases);
		if (postponed === null) throw new Error('expected an activated cutover');
		expect(transitionPinName(postponed)).toBe('transition/2027-01-08.json');
		expect(JSON.parse(serializeTransitionPin(postponed, [])).window).toEqual({
			start: '2027-01-08T00:00:00.000Z',
			end: '2027-01-08T05:00:00.000Z',
		});
		expect(transitionPinCutoff(postponed).toISOString()).toBe('2027-01-09T05:00:00.000Z');
	});

	it('has no cutover, and so no pin, before step 2 (no effectiveUntil, or not announced)', () => {
		for (const releases of [
			[v1(null), v2('2027-01-01', '2026-12-01T00:00:00.000Z')],
			[v1('2026-12-31'), v2('2027-01-01', null)],
		]) {
			const [, next] = releases;
			expect(next === undefined ? 'missing' : activatedCutoverInto(next, releases)).toBeNull();
		}
	});
});

describe('review findings on 57cf67d (each fails there)', () => {
	it('S1: a stored gap receipt the print omits is a mismatch, not an empty pin and a MATCH', async () => {
		await collect();
		await attest([await settle()]);
		const receipt = path.join(root, 'rounds/2027-01-01/2027-01-01T00:00Z.json');
		await rename(receipt, `${receipt}.aside`);
		await freeze();
		await rename(`${receipt}.aside`, receipt);
		expect(await prove()).toMatchObject({
			kind: 'mismatch',
			problems: [
				expect.stringMatching(
					/^the archive serves 2027-01-01T00:00Z \S+ valid, which the indicative print of 2026-12-31 omits$/,
				),
			],
		});
	});

	it('S5: an explorer outage on the pin’s block cannot be verified, never an error', async () => {
		await collect();
		await pin(await gapRounds());
		const explorer = globalThis.fetch;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				const height = Number(/\/block-height\/(\d+)$/.exec(url)?.[1] ?? -1);
				return height === 101 ? new Response('down', { status: 503 }) : explorer(url);
			}),
		);
		expect(await prove()).toMatchObject({
			kind: 'cannot_verify',
			reason: expect.stringContaining('block 101'),
		});
	});

	it('O5: a pin whose proof reaches a block well before the gap ended is a mismatch', async () => {
		await collect();
		const rounds = await gapRounds();
		const name = transitionPinName(cutover());
		// Stamped "timely", then its block dated three hours before the gap ends.
		await pin(rounds);
		const height = 101;
		const block = blocks.get(height);
		if (block === undefined) throw new Error('no pin block');
		blocks.set(height, { ...block, time: Date.parse('2027-01-01T02:00:00Z') / 1000 });
		expect(await prove()).toMatchObject({
			kind: 'mismatch',
			problems: [expect.stringContaining(`${name}`)],
		});
	});

	it('O3: no pin is written in the last 12 hours before its cutoff', async () => {
		await expect(
			writeTransitionPin(checkout.directory, cutover(), [], new Date('2027-01-01T17:00:00Z')),
		).rejects.toThrow(/12 hours before its cutoff/);
	});
});

describe('review findings on e36c1c9 (each fails there)', () => {
	it('Sol r2 S2: before E−1 is due (07:30Z), an unserved print is retried, not a failed run', async () => {
		await collect();
		await settle();
		commit('empty');
		const run = await pinAt('2027-01-01T05:45:00Z');
		expect(run).toEqual({
			line: '2026-12-31: gap pin transition/2027-01-01.json not written yet: the indicative print of 2026-12-31 is not served yet (it is due by 2027-01-01T07:30:00.000Z); the next run retries',
			failed: false,
		});
	});

	it('Sol r2 S2: from E−1’s due time (07:30Z), an unserved print fails the run', async () => {
		await collect();
		await settle();
		commit('empty');
		const run = await pinAt('2027-01-01T07:30:00Z');
		expect(run.failed).toBe(true);
		expect(run.line).toMatch(
			/^2026-12-31: FAILED: .*E−1 does not rebuild: indicative day 2026-12-31 is not served at /,
		);
	});

	it('Sol r2 S3: the gap reads run 6 at a time and give up as cannot-verify past their budget', async () => {
		let inFlight = 0;
		let most = 0;
		const slow: Get = async () => {
			inFlight += 1;
			most = Math.max(most, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 20));
			inFlight -= 1;
			return new Response('none', { status: 404 });
		};
		expect(await readGapReceipts(cutover(), SITE, slow)).toEqual([]);
		expect(most).toBe(6);
		const hanging: Get = () => new Promise(() => {});
		await expect(readGapReceipts(cutover(), SITE, hanging, { budgetMs: 50 })).rejects.toThrow(
			/the 60 gap reads did not finish within 0\.05 s/,
		);
	});
});
