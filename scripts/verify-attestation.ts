/**
 * Checks the live print for a date against its attestation on the attestations branch, and the
 * attestation's OpenTimestamps proof against the publication cutoff (D+2 00:00Z).
 *
 *   npm run verify-attestation -- <YYYY-MM-DD> [--dir attestations] [--base-url URL]
 *
 * Exit codes: 0 MATCH (print matches and its time is proven before the cutoff), 1 MISMATCH
 * (including an invalid or late proof), 2 could not verify, 3 UNATTESTED (the live print has no
 * attestation), 4 PENDING (the print matches; the proof has not reached a Bitcoin block yet).
 */
import { DEFAULT_DIRECTORY, verifyAttested } from './lib/attestations';
import { requireDate, runCheck } from './lib/public-api';

runCheck(
	'npm run verify-attestation -- <YYYY-MM-DD> [--dir attestations] [--base-url URL]',
	({ target, baseUrl, options }) =>
		verifyAttested(baseUrl, options.get('dir') ?? DEFAULT_DIRECTORY, requireDate(target)),
	['dir'],
);
