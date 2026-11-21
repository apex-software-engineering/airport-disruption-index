import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAttestation, serializeAttestation } from '@/lib/index/attestation';
import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { buildPrint } from '@/lib/index/print';
import { summarizeReceipt } from '@/lib/index/round';
import { collectedReceipt } from '@/test/receipts';
import type { DailyPrint } from '@/lib/index/schemas';
import { feedFixture, otsFixture } from '@/test/fixtures';

import { fetchBlock, invalidProofs, readPins, verifyAttested } from './attestations';
import { CannotVerify, getApi } from './public-api';

const receipt = collectedReceipt({
	fetchedAt: new Date('2026-11-17T20:45:02.123Z'),
	sourceUrl: CURRENT_ADAPTER.url,
	outcome: { kind: 'response', httpStatus: 200, body: feedFixture('synthetic-gs-gdp.xml') },
});
const r1 = buildPrint('2026-11-17', [summarizeReceipt(receipt)], { revision: 1 });
const r2 = buildPrint('2026-11-17', [], {
	revision: 2,
	supersedesPrintHash: r1.printHash,
	reason: 'test correction',
});
const pin1 = serializeAttestation(buildAttestation(r1, null));

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

/** A git repo standing in for a checkout of the attestations branch. */
function branchCheckout(): {
	directory: string;
	commit: (files: Record<string, string | null>) => void;
} {
	const directory = mkdtempSync(path.join(tmpdir(), 'adi-attestations-'));
	directories.push(directory);
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', directory, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
			stdio: 'ignore',
		});
	git('init', '--quiet');
	return {
		directory,
		commit: (files) => {
			for (const [name, content] of Object.entries(files)) {
				if (content === null) git('rm', '--quiet', name);
				else writeFileSync(path.join(directory, name), content);
			}
			git('add', '--all');
			git('commit', '--quiet', '--no-gpg-sign', '-m', 'test');
		},
	};
}

function serveDay(print: DailyPrint, revisions: DailyPrint[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ date: print.date, status: 'settled', print, revisions })),
	);
}

describe('readPins', () => {
	it('finds nothing on a branch with no commits yet', () => {
		expect(readPins(branchCheckout().directory, '2026-11-17')).toEqual({ pins: [], problems: [] });
	});

	it('reads each attestation as first committed', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		const { pins, problems } = readPins(branch.directory, '2026-11-17');
		expect(problems).toEqual([]);
		expect(pins.map((pin) => [pin.name, new TextDecoder().decode(pin.bytes)])).toEqual([
			['2026-11-17.r1.json', pin1],
		]);
	});

	it('flags a later modification and keeps the first-committed bytes', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.commit({
			'2026-11-17.r1.json': pin1.replace(
				'"deployedCommit": null',
				'"deployedCommit": "' + 'a'.repeat(40) + '"',
			),
		});
		const { pins, problems } = readPins(branch.directory, '2026-11-17');
		expect(problems).toEqual([
			expect.stringMatching(/^2026-11-17\.r1\.json was modified in [0-9a-f]{40}$/),
		]);
		expect(new TextDecoder().decode(pins[0]?.bytes)).toBe(pin1);
	});

	it('flags a deletion', () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		branch.commit({ '2026-11-17.r1.json': null });
		expect(readPins(branch.directory, '2026-11-17').problems).toEqual([
			expect.stringMatching(/^2026-11-17\.r1\.json was deleted in /),
		]);
	});

	it('refuses a directory that is not the root of its own checkout', () => {
		const branch = branchCheckout();
		const nested = path.join(branch.directory, 'nested');
		mkdirSync(nested);
		expect(() => readPins(nested, '2026-11-17')).toThrow(CannotVerify);
	});
});

describe('verifyAttested', () => {
	it('rejects a pinned revision the API no longer serves', async () => {
		const branch = branchCheckout();
		branch.commit({
			'2026-11-17.r1.json': pin1,
			'2026-11-17.r2.json': serializeAttestation(buildAttestation(r2, null)),
		});
		serveDay(r1, [r1]);
		expect(await verifyAttested('https://example.test', branch.directory, '2026-11-17')).toEqual([
			'revision 2 is attested but the API no longer serves it',
		]);
	});

	it('is UNATTESTED when the current revision has no pin', async () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r1.json': pin1 });
		serveDay(r2, [r1, r2]);
		await expect(
			verifyAttested('https://example.test', branch.directory, '2026-11-17'),
		).rejects.toThrow(/is revision 2; .*2026-11-17\.r2\.json is not on the branch/);
	});

	it('cannot verify a correction, whose cutoff needs an issue time prints do not record', async () => {
		const branch = branchCheckout();
		branch.commit({ '2026-11-17.r2.json': serializeAttestation(buildAttestation(r2, null)) });
		serveDay(r2, [r1, r2]);
		await expect(
			verifyAttested('https://example.test', branch.directory, '2026-11-17'),
		).rejects.toThrow(/correction; its cutoff is 48 hours after/);
	});
});

describe('invalidProofs', () => {
	it('passes a pending proof that commits to its file and flags a malformed one', async () => {
		const branch = branchCheckout();
		writeFileSync(path.join(branch.directory, '2026-11-20.r1.json'), otsFixture('pending.json'));
		writeFileSync(
			path.join(branch.directory, '2026-11-20.r1.json.ots'),
			otsFixture('pending.json.ots'),
		);
		expect(await invalidProofs(branch.directory, new Set())).toEqual([]);
		writeFileSync(
			path.join(branch.directory, '2026-11-20.r1.json.ots'),
			otsFixture('hello-world.txt'),
		);
		expect(await invalidProofs(branch.directory, new Set())).toEqual([
			expect.stringMatching(/2026-11-20\.r1\.json\.ots is not a valid proof/),
		]);
	});
});

describe('the preview bypass secret', () => {
	function recordFetches(body: (url: string) => Response) {
		const calls: { url: string; headers: HeadersInit | undefined }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, headers: init?.headers });
				return body(url);
			}),
		);
		return calls;
	}

	it('goes to the API under check', async () => {
		vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'secret');
		const calls = recordFetches(() => new Response('{}'));
		await getApi('https://preview.example.test/api/v1/methodology');
		expect(calls[0]?.headers).toHaveProperty('x-vercel-protection-bypass', 'secret');
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
