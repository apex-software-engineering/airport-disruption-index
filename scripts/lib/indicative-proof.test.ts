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

import { buildAttestation, serializeAttestation } from '@/lib/index/attestation';
import type { DailyPrint } from '@/lib/index/schemas';
import { routeGet } from '@/test/api';
import { collectAt } from '@/test/collect';
import { syntheticProof } from '@/test/ots';
import { settleDay } from '@/server/archive';
import { freezeIndicativeDay } from '@/server/indicative-archive';
import { FileStore } from '@/server/storage';

import type { BranchCheckout } from './attestations';
import { proveIndicativeDay } from './indicative-proof';

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

/** Commits an attestation of each print, proven in a block well before its cutoff. */
async function attest(prints: readonly DailyPrint[]) {
	const blocks = new Map<number, { merkleRoot: string; time: number }>();
	for (const [index, print] of prints.entries()) {
		const name = `${print.date}.r${print.revision}.json`;
		const file = serializeAttestation(buildAttestation(print, null));
		const height = 100 + index;
		const { proof, merkleRoot } = syntheticProof(new TextEncoder().encode(file), {
			kind: 'bitcoin',
			height,
		});
		await writeFile(path.join(checkout.directory, name), file);
		await writeFile(path.join(checkout.directory, `${name}.ots`), proof);
		// A block a few hours after the day ends, inside its r1 cutoff (end + 24 h).
		blocks.set(height, {
			merkleRoot,
			time: Date.parse(`${print.date}T00:00:00Z`) / 1000 + 30 * 3600,
		});
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
});
