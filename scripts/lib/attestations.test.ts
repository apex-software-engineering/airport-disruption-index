import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAttestation, serializeAttestation } from '@/lib/index/attestation';
import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { buildPrint } from '@/lib/index/print';
import { summarizeReceipt } from '@/lib/index/round';
import type { DailyPrint } from '@/lib/index/schemas';
import { feedFixture, otsFixture } from '@/test/fixtures';
import { syntheticProof } from '@/test/ots';
import { collectedReceipt } from '@/test/receipts';

import {
	fetchBlock,
	invalidProofs,
	readPins,
	verifyAttested,
	type BranchCheckout,
} from './attestations';
import { CannotVerify, getApi } from './public-api';

const receipt = collectedReceipt({
	fetchedAt: new Date('2026-11-17T20:45:02.123Z'),
	sourceUrl: CURRENT_ADAPTER.url,
	outcome: { kind: 'response', httpStatus: 200, body: feedFixture('synthetic-gs-gdp.xml') },
});
const r1 = buildPrint('2026-11-17', [summarizeReceipt(receipt)], { revision: 1 });
const r2 = buildPrint('2026-11-17', [], {
	revision: 2,
	correction: {
		supersedesPrintHash: r1.printHash,
		reason: 'test correction',
		issuedAt: '2026-11-18T10:00:00.000Z',
		windowOverride: null,
	},
});
const pin1 = serializeAttestation(buildAttestation(r1, null));

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Files = Record<string, string | Uint8Array | null>;

/**
 * A git repo standing in for a checkout of the attestations branch. Each commit also moves
 * origin/attestations to it, as a fetch would.
 */
function branchCheckout() {
	const directory = mkdtempSync(path.join(tmpdir(), 'adi-attestations-'));
	directories.push(directory);
	const checkout: BranchCheckout = { directory, branch: 'attestations' };
	const git = (...args: string[]) =>
		execFileSync(
			'git',
			[
				'-C',
				directory,
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
	const apply = (files: Files) => {
		for (const [name, content] of Object.entries(files)) {
			if (content === null) git('rm', '--quiet', name);
			else writeFileSync(path.join(directory, name), content);
		}
		git('add', '--all');
	};
	const publish = () => git('update-ref', 'refs/remotes/origin/attestations', 'HEAD');
	git('init', '--quiet', '--initial-branch=work');
	return {
		checkout,
		git,
		commit(files: Files) {
			apply(files);
			git('commit', '--quiet', '-m', 'commit');
			publish();
		},
		/** A merge whose own commit also applies `inMerge`, which a plain log would not show. */
		evilMerge(files: Files) {
			git('switch', '--quiet', '-c', 'side');
			apply({ 'side.txt': 'side' });
			git('commit', '--quiet', '-m', 'side');
			git('switch', '--quiet', 'work');
			git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
			apply(files);
			git('commit', '--quiet', '-m', 'merge');
			publish();
		},
	};
}

describe('readPins', () => {
	it('finds nothing on a branch with no commits yet', () => {
		expect(readPins(branchCheckout().checkout, '2026-11-17')).toEqual({ pins: [], problems: [] });
	});

	it('reads each attestation as first committed', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		const { pins, problems } = readPins(branch.checkout, '2026-11-17');
		expect(problems).toEqual([]);
		expect(pins.map((pin) => [pin.name, new TextDecoder().decode(pin.bytes)])).toEqual([
			['2026-11-17.r1.json', pin1],
		]);
	});

	const rewritten = pin1.replace('"deployedCommit": null', `"deployedCommit": "${'a'.repeat(40)}"`);

	it('flags a later modification and keeps the first-committed bytes', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.commit({ '2026-11-17.r1.json': rewritten });
		const { pins, problems } = readPins(branch.checkout, '2026-11-17');
		expect(problems).toEqual([
			expect.stringMatching(/^2026-11-17\.r1\.json was modified in [0-9a-f]{40}$/),
		]);
		expect(new TextDecoder().decode(pins[0]?.bytes)).toBe(pin1);
	});

	it('flags a deletion', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.commit({ '2026-11-17.r1.json': null });
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([
			expect.stringMatching(/^2026-11-17\.r1\.json was deleted in /),
		]);
	});

	const mergeCommit = expect.stringMatching(
		/^publication history contains merge commit [0-9a-f]{40}; it must be linear$/,
	);

	it('flags a rewrite made inside a merge commit, and the merge itself', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.evilMerge({ '2026-11-17.r1.json': rewritten });
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([
			mergeCommit,
			expect.stringMatching(/^2026-11-17\.r1\.json was modified in /),
		]);
	});

	it('flags a deletion made inside a merge commit, and the merge itself', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.evilMerge({ '2026-11-17.r1.json': null });
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([
			mergeCommit,
			expect.stringMatching(/^2026-11-17\.r1\.json was deleted in /),
		]);
	});

	it('flags any merge commit, even one that changes no attestation', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.evilMerge({});
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([mergeCommit]);
	});

	it('refuses a directory that is not the root of its own checkout', () => {
		const branch = branchCheckout();
		const nested = path.join(branch.checkout.directory, 'nested');
		mkdirSync(nested);
		expect(() => readPins({ ...branch.checkout, directory: nested }, '2026-11-17')).toThrow(
			CannotVerify,
		);
	});

	it('refuses a shallow checkout, whose history is incomplete', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.commit({ '2026-11-17.r1.json': rewritten });
		const shallow = mkdtempSync(path.join(tmpdir(), 'adi-shallow-'));
		directories.push(shallow);
		execFileSync('git', [
			'clone',
			'--quiet',
			'--depth=1',
			`file://${branch.checkout.directory}`,
			shallow,
		]);
		execFileSync('git', ['-C', shallow, 'update-ref', 'refs/remotes/origin/attestations', 'HEAD']);
		expect(() => readPins({ directory: shallow, branch: 'attestations' }, '2026-11-17')).toThrow(
			/shallow checkout/,
		);
	});

	/** A bare repo standing in for GitHub, holding the branch as published. */
	function withRemote(branch: ReturnType<typeof branchCheckout>) {
		const remote = mkdtempSync(path.join(tmpdir(), 'adi-remote-'));
		directories.push(remote);
		execFileSync('git', ['init', '--quiet', '--bare', remote]);
		branch.git('remote', 'add', 'origin', remote);
		branch.git('push', '--quiet', 'origin', 'HEAD:refs/heads/attestations');
		return remote;
	}

	it('accepts a checkout at the live tip of the branch', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		withRemote(branch);
		const warn = vi.spyOn(console, 'warn');
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});

	it('refuses a stale checkout when the remote has moved on', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		const remote = withRemote(branch);
		const other = mkdtempSync(path.join(tmpdir(), 'adi-other-'));
		directories.push(other);
		execFileSync('git', ['clone', '--quiet', '--branch', 'attestations', remote, other]);
		writeFileSync(path.join(other, 'later.txt'), 'x');
		const git = (...args: string[]) =>
			execFileSync('git', ['-C', other, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
		git('add', '--all');
		git('commit', '--quiet', '--no-gpg-sign', '-m', 'later');
		git('push', '--quiet', 'origin', 'HEAD:refs/heads/attestations');
		expect(() => readPins(branch.checkout, '2026-11-17')).toThrow(/^stale checkout, fetch first/);
	});

	it('refuses an empty checkout when the remote has the branch: fetch first', () => {
		const published = branchCheckout();
		published.commit({ '2026-11-17.r1.json': pin1 });
		const remote = withRemote(published);
		const empty = branchCheckout();
		empty.git('remote', 'add', 'origin', remote);
		expect(() => readPins(empty.checkout, '2026-11-17')).toThrow(
			/^fetch first: origin has attestations/,
		);
	});

	it('treats an empty checkout as unpublished when the remote has no such branch', () => {
		const remote = mkdtempSync(path.join(tmpdir(), 'adi-remote-'));
		directories.push(remote);
		execFileSync('git', ['init', '--quiet', '--bare', remote]);
		const empty = branchCheckout();
		empty.git('remote', 'add', 'origin', remote);
		expect(readPins(empty.checkout, '2026-11-17')).toEqual({ pins: [], problems: [] });
	});

	it('warns and goes on when the remote cannot be reached', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(readPins(branch.checkout, '2026-11-17').problems).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not reach origin/));
	});

	it('refuses a checkout that is not at the tip of origin/{branch}', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		expect(() => readPins({ ...branch.checkout, branch: 'other' }, '2026-11-17')).toThrow(
			/not origin\/other \(missing\)/,
		);
		branch.commit({ 'later.txt': 'x' });
		branch.git('checkout', '--quiet', '--detach', 'HEAD~1');
		expect(() => readPins(branch.checkout, '2026-11-17')).toThrow(/not origin\/attestations/);
	});
});

function serveDay(print: DailyPrint, revisions: DailyPrint[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ date: print.date, status: 'settled', print, revisions })),
	);
}

describe('verifyAttested', () => {
	it('rejects a pinned revision the API no longer serves', async () => {
		const branch = branchCheckout();
		branch.commit({
			'2026-11-17.r1.json': pin1,
			'2026-11-17.r2.json': serializeAttestation(buildAttestation(r2, null)),
		});
		serveDay(r1, [r1]);
		expect(await verifyAttested('https://example.test', branch.checkout, '2026-11-17')).toEqual([
			'revision 2 is attested but the API no longer serves it',
		]);
	});

	it('is UNATTESTED when the current revision has no pin', async () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		serveDay(r2, [r1, r2]);
		await expect(
			verifyAttested('https://example.test', branch.checkout, '2026-11-17'),
		).rejects.toThrow(/is revision 2; .*2026-11-17\.r2\.json is not on the branch/);
	});
});

describe('verifyAttested on a correction', () => {
	// r2 is built through main's correctionSchema; its cutoff is 48 hours after issuedAt.
	const file = serializeAttestation(buildAttestation(r2, null));
	const { proof, merkleRoot } = syntheticProof(new TextEncoder().encode(file), {
		kind: 'bitcoin',
		height: 100,
	});

	async function verifyWithBlockAt(time: string) {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r2.json': file, '2026-11-17.r2.json.ots': proof });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				if (url.endsWith('/api/v1/days/2026-11-17'))
					return Response.json({
						date: '2026-11-17',
						status: 'settled',
						print: r2,
						revisions: [r1, r2],
					});
				if (url.endsWith('/block-height/100')) return new Response('00ff');
				return Response.json({
					height: 100,
					merkle_root: merkleRoot,
					timestamp: Date.parse(time) / 1000,
				});
			}),
		);
		return verifyAttested('https://example.test', branch.checkout, '2026-11-17');
	}

	it('matches when the block is within 48 hours of correction.issuedAt', async () => {
		expect(await verifyWithBlockAt('2026-11-20T09:00:00Z')).toEqual([]);
	});

	it('fails when the block is after that cutoff', async () => {
		expect(await verifyWithBlockAt('2026-11-20T11:00:00Z')).toEqual([
			expect.stringMatching(/after the publication cutoff 2026-11-20T10:00:00.000Z$/),
		]);
	});
});

describe('invalidProofs', () => {
	it('passes a pending proof that commits to its file and flags a malformed one', async () => {
		const { directory } = branchCheckout().checkout;
		const write = (name: string, bytes: Uint8Array) =>
			writeFileSync(path.join(directory, name), bytes);
		write('2026-11-20.r1.json', otsFixture('pending.json'));
		write('2026-11-20.r1.json.ots', otsFixture('pending.json.ots'));
		expect(await invalidProofs(directory, ['2026-11-20.r1.json'])).toEqual([]);
		write('2026-11-20.r1.json.ots', otsFixture('hello-world.txt'));
		expect(await invalidProofs(directory, ['2026-11-20.r1.json'])).toEqual([
			{
				name: '2026-11-20.r1.json',
				problem: expect.stringMatching(/2026-11-20\.r1\.json\.ots is not a valid proof/),
			},
		]);
	});

	it('reports a proof without its attestation for that name only, and checks the rest', async () => {
		const { directory } = branchCheckout().checkout;
		const write = (name: string, bytes: Uint8Array) =>
			writeFileSync(path.join(directory, name), bytes);
		write('2026-11-19.r1.json.ots', otsFixture('pending.json.ots'));
		write('2026-11-20.r1.json', otsFixture('pending.json'));
		write('2026-11-20.r1.json.ots', otsFixture('pending.json.ots'));
		expect(await invalidProofs(directory, ['2026-11-19.r1.json', '2026-11-20.r1.json'])).toEqual([
			{
				name: '2026-11-19.r1.json',
				problem: expect.stringMatching(/has no attestation file beside it$/),
			},
		]);
	});
});

describe('the preview bypass secret', () => {
	function recordFetches(body: (url: string) => Response) {
		const calls: { url: string; headers: HeadersInit | undefined; redirect?: RequestRedirect }[] =
			[];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, headers: init?.headers, redirect: init?.redirect });
				return body(url);
			}),
		);
		return calls;
	}

	it('goes to the API under check, on a request that refuses redirects', async () => {
		vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'secret');
		const calls = recordFetches(() => new Response('{}'));
		await getApi('https://preview.example.test/api/v1/methodology');
		expect(calls[0]?.headers).toHaveProperty('x-vercel-protection-bypass', 'secret');
		expect(calls[0]?.redirect).toBe('error');
	});

	it('cannot be carried to another location by a redirect', async () => {
		vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'secret');
		const seen: string[] = [];
		const server = createServer((request, response) => {
			seen.push(`${request.url} ${request.headers['x-vercel-protection-bypass'] ?? '-'}`);
			if (request.url === '/start') response.writeHead(302, { Location: '/elsewhere' }).end();
			else response.end('{}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no TCP address');
		try {
			await expect(getApi(`http://127.0.0.1:${address.port}/start`)).rejects.toThrow();
			expect(seen).toEqual(['/start secret']);
		} finally {
			server.close();
		}
	});

	it('never goes to the block explorer', async () => {
		vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'secret');
		const calls = recordFetches((url) =>
			url.includes('block-height')
				? new Response('00ab')
				: Response.json({ height: 7, merkle_root: 'cd', timestamp: 1 }),
		);
		expect(await fetchBlock(7)).toEqual({ merkleRoot: 'cd', time: new Date(1000) });
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.url).toMatch(/^https:\/\/mempool\.space\/api\//);
			expect(call.headers).not.toHaveProperty('x-vercel-protection-bypass');
		}
	});
});
