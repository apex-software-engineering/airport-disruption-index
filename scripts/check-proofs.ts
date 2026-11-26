/**
 * Checks the named attestations' OpenTimestamps proofs offline: each must parse and commit to
 * its attestation file. Pending proofs pass. The attest workflow runs it on the files it is about
 * to publish, and publishes only those it prints as OK: if this fails to run, nothing goes out.
 *
 *   npm run check-proofs -- <dir> <YYYY-MM-DD.rN.json ...>
 *
 * Prints `OK <name>` per good proof and `INVALID <name>: <problem>` per bad one. Exit 0 when none
 * is bad, 1 otherwise.
 */
import { invalidProofs } from './lib/attestations';
import { printable } from './lib/public-api';

const [directory, ...names] = process.argv.slice(2);
if (directory === undefined) {
	console.error('usage: npm run check-proofs -- <dir> <YYYY-MM-DD.rN.json ...>');
	process.exitCode = 2;
} else {
	void invalidProofs(directory, names).then((invalid) => {
		const bad = new Set(invalid.map(({ name }) => name));
		for (const name of names) if (!bad.has(name)) console.log(`OK ${name}`);
		for (const { name, problem } of invalid) console.log(printable(`INVALID ${name}: ${problem}`));
		console.log(invalid.length === 0 ? 'PROOFS OK' : `${invalid.length} invalid proof(s)`);
		process.exitCode = invalid.length === 0 ? 0 : 1;
	});
}
