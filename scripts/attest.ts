/**
 * Attests every settled day in a window ending at a date: a day whose live print has no
 * attestation is reproduced from the public API and, only on MATCH, written to
 * `{dir}/{date}.r{revision}.json`; a day that has one is verified against it. Run by the attest
 * workflow, which then stamps and publishes the new files.
 *
 *   npm run attest -- <YYYY-MM-DD> [--days 1] [--dir attestations] [--base-url URL]
 *
 * A day not yet settled before its `publishBy` (this checkout's calendar, which the API must state
 * too; see fetchPublication) is skipped as not yet published; one still unsettled at or after it
 * is overdue, and fails.
 *
 * Then every proof in the directory, of any date, is checked offline: invalid proofs are reported
 * apart from pending ones. Exit 0 when every day in the window is attested and matches (a pending
 * proof is fine) or not yet due, and no proof is invalid; 1 otherwise: a day overdue, mismatched
 * or unreachable, or a proof that is invalid.
 */
import { buildAttestation } from '@/lib/index/attestation';
import { fetchPublication, reproduceFetchedDay } from '@/lib/reproduce';
import { addDays, type UtcDate } from '@/lib/index/time';

import {
	DEFAULT_BRANCH,
	DEFAULT_DIRECTORY,
	attestationNames,
	invalidProofs,
	verifyAttestedDay,
	writeAttestation,
	type BranchCheckout,
} from './lib/attestations';
import {
	CannotVerify,
	Mismatch,
	Pending,
	Unattested,
	describeError,
	fetchDay,
	getApi,
	parseArgs,
	requireDate,
} from './lib/public-api';

const USAGE =
	'npm run attest -- <YYYY-MM-DD> [--days 1] [--dir attestations] [--branch attestations] [--base-url URL]';
/** Collection began 2026-11-20T04:30Z; no earlier day has a print. */
const FIRST_PRINT_DATE = '2026-11-20';

/** The day's outcome, and the file written for it, if any. */
async function attestDay(
	baseUrl: string,
	checkout: BranchCheckout,
	date: UtcDate,
): Promise<{ outcome: string; written: string | null }> {
	const publication = await fetchPublication(baseUrl, date, () => new Date(), getApi);
	if (publication.kind === 'not_yet_due') {
		return { outcome: `not yet published (due by ${publication.publishBy})`, written: null };
	}
	if (publication.kind === 'overdue') {
		throw new CannotVerify(`not settled, and its print was due by ${publication.publishBy}`);
	}
	// One response for everything: the pins are checked against it, and it is what gets attested.
	const day = await fetchDay(baseUrl, date);
	try {
		const problems = await verifyAttestedDay(day, checkout);
		if (problems.length > 0) throw new Mismatch(problems);
		return { outcome: 'attested, timestamp proven', written: null };
	} catch (error) {
		if (error instanceof Pending) return { outcome: 'attested, timestamp pending', written: null };
		if (!(error instanceof Unattested)) throw error;
	}
	const outcome = await reproduceFetchedDay(day, baseUrl, getApi);
	for (const line of outcome.log) console.log(line);
	if (outcome.kind === 'cannot_verify') throw new CannotVerify(outcome.reason);
	if (outcome.kind === 'mismatch')
		throw new Mismatch(outcome.problems.map((p) => `reproduce: ${p}`));
	const written = await writeAttestation(
		checkout.directory,
		buildAttestation(day.print, day.deployedCommit),
	);
	return { outcome: `reproduced MATCH, wrote ${written}`, written };
}

async function main(): Promise<number> {
	const { target, baseUrl, options } = parseArgs(process.argv.slice(2), USAGE, [
		'days',
		'dir',
		'branch',
	]);
	const through = requireDate(target);
	const days = Number(options.get('days') ?? '1');
	if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
	const checkout = {
		directory: options.get('dir') ?? DEFAULT_DIRECTORY,
		branch: options.get('branch') ?? DEFAULT_BRANCH,
	};
	let failures = 0;
	const written = new Set<string>();
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const date = addDays(through, -offset);
		if (date < FIRST_PRINT_DATE) continue;
		try {
			const day = await attestDay(baseUrl, checkout, date);
			if (day.written !== null) written.add(day.written);
			console.log(`${date}: ${day.outcome}`);
		} catch (error) {
			failures += 1;
			console.log(`${date}: FAILED: ${describeError(error)}`);
		}
	}
	// Every earlier proof too, reported apart from the days: written files are not stamped yet.
	const earlier = (await attestationNames(checkout.directory)).filter(
		(name) => !written.has(`${checkout.directory}/${name}`),
	);
	const invalid = await invalidProofs(checkout.directory, earlier);
	for (const { problem } of invalid) console.log(`INVALID PROOF: ${problem}`);
	const ok = failures === 0 && invalid.length === 0;
	console.log(
		ok ? 'ATTESTED' : `FAILED: ${failures} day(s) not attested, ${invalid.length} invalid proof(s)`,
	);
	return ok ? 0 : 1;
}

void main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`cannot attest: ${describeError(error)}`);
		process.exitCode = 1;
	},
);
