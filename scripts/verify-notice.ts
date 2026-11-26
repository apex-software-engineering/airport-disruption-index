/**
 * The step-2 check (design §2): a release's `announcedAt` (N) and `announcedProofAt` (B) are the
 * ones its readback record on the attestations branch proves, the record and its bodies are as
 * first committed, the proof reaches a Bitcoin block, and `effectiveAt ≥ max(N, B) + 30 days`.
 * CI runs it on every change, so a registry change setting N or B merges only when it holds.
 *
 *   npm run verify-notice -- <version> [--dir attestations] [--branch attestations]
 *
 * `--dir` must be a full checkout whose HEAD is origin/{branch}; otherwise exit 2.
 * Exit codes: 0 MATCH (verified, or the release is not announced), 1 MISMATCH, 2 could not verify,
 * 4 PENDING (everything else holds; the proof has not reached a Bitcoin block yet).
 */
import { RELEASES } from '@/lib/index/releases';

import { DEFAULT_BRANCH, DEFAULT_DIRECTORY, fetchBlock } from './lib/attestations';
import { verifyNotice } from './lib/notice-record';
import { CannotVerify, Pending, runCheck } from './lib/public-api';

runCheck(
	'npm run verify-notice -- <version> [--dir attestations] [--branch attestations]',
	async ({ target: version, options }) => {
		const release = RELEASES.find((candidate) => candidate.parameters.version === version);
		if (release === undefined) throw new CannotVerify(`no registered release is ${version}`);
		const checkout = {
			directory: options.get('dir') ?? DEFAULT_DIRECTORY,
			branch: options.get('branch') ?? DEFAULT_BRANCH,
		};
		const verdict = await verifyNotice(checkout, release, RELEASES, fetchBlock);
		switch (verdict.kind) {
			case 'not_announced':
				console.log(`${version} is not announced (announcedAt null): nothing to verify`);
				return [];
			case 'verified':
				console.log(
					`${version}: N ${verdict.noticeAt}, B ${verdict.proofAt}; max(N, B) + 30 days = ${verdict.bound}`,
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
	['dir', 'branch'],
);
