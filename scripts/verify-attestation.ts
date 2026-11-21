/**
 * Checks the live print for a date against its attestations on the attestations branch, and each
 * attestation's OpenTimestamps proof against its publication cutoff.
 *
 *   npm run verify-attestation -- <YYYY-MM-DD> [--dir attestations] [--branch attestations] [--base-url URL]
 *
 * `--dir` must be a full checkout whose HEAD is origin/{branch}; otherwise exit 2.
 * Exit codes: 0 MATCH (print matches and its time is proven before the cutoff), 1 MISMATCH
 * (including an invalid or late proof), 2 could not verify, 3 UNATTESTED (the live print has no
 * attestation), 4 PENDING (the print matches; the proof has not reached a Bitcoin block yet).
 */
import { DEFAULT_BRANCH, DEFAULT_DIRECTORY, verifyAttested } from './lib/attestations';
import { requireDate, runCheck } from './lib/public-api';

runCheck(
	'npm run verify-attestation -- <YYYY-MM-DD> [--dir attestations] [--branch attestations] [--base-url URL]',
	({ target, baseUrl, options }) =>
		verifyAttested(
			baseUrl,
			{
				directory: options.get('dir') ?? DEFAULT_DIRECTORY,
				branch: options.get('branch') ?? DEFAULT_BRANCH,
			},
			requireDate(target),
		),
	['dir', 'branch'],
);
