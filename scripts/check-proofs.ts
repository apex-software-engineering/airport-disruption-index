/**
 * Checks every OpenTimestamps proof in the attestations directory offline: each must parse and
 * commit to its attestation file. Pending proofs pass. Run by the attest workflow after stamping,
 * so a malformed proof is never published.
 *
 *   npm run check-proofs -- [dir]
 */
import { DEFAULT_DIRECTORY, invalidProofs } from './lib/attestations';

void invalidProofs(process.argv[2] ?? DEFAULT_DIRECTORY, new Set()).then((problems) => {
	for (const problem of problems) console.log(`INVALID PROOF: ${problem}`);
	console.log(problems.length === 0 ? 'PROOFS OK' : `${problems.length} invalid proof(s)`);
	process.exitCode = problems.length === 0 ? 0 : 1;
});
