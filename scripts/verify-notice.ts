/**
 * The step-2 check (design §2): a release's `announcedAt` (N), `announcedProofAt` (B) and
 * `announcedProofHeight` are the ones its readback record on the attestations branch proves, the
 * record and its bodies are as first committed and replay, the proof reaches the pinned Bitcoin
 * block (as mempool.space and blockstream.info both report it), and `effectiveAt ≥ max(N, B) + 30 days`. CI runs it on every change to the announcement,
 * the verifier or CI itself, so a registry change setting N or B merges only when it holds.
 *
 *   npm run verify-notice -- <version> [--dir attestations] [--branch attestations] [--clone-from URL]
 *
 * `--dir` must be a full checkout whose HEAD is origin/{branch}; otherwise exit 2. With
 * `--clone-from` (CI), the checkout is cloned there only once the release is announced, and a check
 * that could not run (a push racing the clone, an unreachable explorer) is fetched and run once
 * more before it counts.
 * Exit codes: 0 MATCH (verified, or the release is not announced), 1 MISMATCH, 2 could not verify,
 * 4 PENDING (everything else holds; the proof has not reached a Bitcoin block yet).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { RELEASES } from '@/lib/index/releases';

import {
	DEFAULT_BRANCH,
	DEFAULT_DIRECTORY,
	GIT_TIMEOUT_MS,
	fetchBlockAgreed,
	type BranchCheckout,
} from './lib/attestations';
import { verifyNotice } from './lib/notice-record';
import { CannotVerify, Pending, runCheck } from './lib/public-api';

function git(args: string[]): void {
	try {
		execFileSync('git', args, { stdio: ['ignore', 'ignore', 'inherit'], timeout: GIT_TIMEOUT_MS });
	} catch (error) {
		throw new CannotVerify(`git ${args.join(' ')} failed: ${String(error)}`);
	}
}

/** Clones the branch into the checkout, or fetches it and moves the checkout to its tip. */
function bringUpToDate({ directory, branch }: BranchCheckout, origin: string): void {
	if (!existsSync(directory)) {
		git(['clone', '--quiet', '--single-branch', '--branch', branch, origin, directory]);
		return;
	}
	git(['-C', directory, 'fetch', '--quiet', 'origin']);
	git(['-C', directory, 'checkout', '--quiet', '--detach', `origin/${branch}`]);
}

runCheck(
	'npm run verify-notice -- <version> [--dir attestations] [--branch attestations] [--clone-from URL]',
	async ({ target: version, options }) => {
		const checkout = {
			directory: options.get('dir') ?? DEFAULT_DIRECTORY,
			branch: options.get('branch') ?? DEFAULT_BRANCH,
		};
		const origin = options.get('clone-from');
		const release = RELEASES.find((candidate) => candidate.parameters.version === version);
		const announced = release !== undefined && release.announcedAt !== null;
		const verify = () => verifyNotice(checkout, version, RELEASES, fetchBlockAgreed);
		let verdict;
		if (origin === undefined || !announced) verdict = await verify();
		else {
			try {
				bringUpToDate(checkout, origin);
				verdict = await verify();
			} catch (error) {
				if (!(error instanceof CannotVerify)) throw error;
				console.warn(`could not verify (${error.message}); fetching and trying once more`);
				bringUpToDate(checkout, origin);
				verdict = await verify();
			}
		}
		switch (verdict.kind) {
			case 'not_announced':
				console.log(`${version} is not announced (announcedAt null): nothing to verify`);
				return [];
			case 'verified':
				console.log(
					`${version}: N ${verdict.noticeAt}, B ${verdict.proofAt} (Bitcoin block ${verdict.proofHeight}); max(N, B) + 30 days = ${verdict.bound}`,
				);
				return [];
			case 'pending':
				throw new Pending(
					`the ${version} readback record checks out, but its proof is pending at ${verdict.calendars.join(', ')}`,
				);
			case 'invalid':
				return verdict.problems;
		}
	},
	['dir', 'branch', 'clone-from'],
);
