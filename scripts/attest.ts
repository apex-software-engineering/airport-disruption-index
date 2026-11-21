/**
 * Attests every settled day in a window ending at a date: a day whose live print has no
 * attestation is reproduced from the public API and, only on MATCH, written to
 * `{dir}/{date}.r{revision}.json`; a day that has one is verified against it. Run by the attest
 * workflow, which then stamps and publishes the new files.
 *
 *   npm run attest -- <YYYY-MM-DD> [--days 1] [--dir attestations] [--base-url URL]
 *
 * Then every proof in the directory, of any date, is checked offline: invalid proofs are reported
 * apart from pending ones. Exit 0 when every day in the window is attested and matches (a pending
 * proof is fine) and no proof is invalid; 1 otherwise: a day unsettled, mismatched or unreachable,
 * or a proof that is invalid.
 */
import { buildAttestation } from '@/lib/index/attestation';
import { reproduceSettledDay } from '@/lib/reproduce';
import { addDays, type UtcDate } from '@/lib/index/time';

import {
	DEFAULT_DIRECTORY,
	invalidProofs,
	verifyAttested,
	writeAttestation,
} from './lib/attestations';
import {
	CannotVerify,
	Mismatch,
	Pending,
	Unattested,
	describeError,
	getApi,
	parseArgs,
	requireDate,
} from './lib/public-api';

const USAGE = 'npm run attest -- <YYYY-MM-DD> [--days 1] [--dir attestations] [--base-url URL]';
/** Collection began 2026-11-20T04:30Z; no earlier day has a print. */
const FIRST_PRINT_DATE = '2026-11-20';

/** The day's outcome, and the file written for it, if any. */
async function attestDay(
	baseUrl: string,
	directory: string,
	date: UtcDate,
): Promise<{ outcome: string; written: string | null }> {
	try {
		const problems = await verifyAttested(baseUrl, directory, date);
		if (problems.length > 0) throw new Mismatch(problems);
		return { outcome: 'attested, timestamp proven', written: null };
	} catch (error) {
		if (error instanceof Pending) return { outcome: 'attested, timestamp pending', written: null };
		if (!(error instanceof Unattested)) throw error;
	}
	const { outcome, reproduced } = await reproduceSettledDay(date, baseUrl, getApi);
	for (const line of outcome.log) console.log(line);
	if (outcome.kind === 'cannot_verify') throw new CannotVerify(outcome.reason);
	if (outcome.kind === 'mismatch')
		throw new Mismatch(outcome.problems.map((p) => `reproduce: ${p}`));
	if (reproduced === null) throw new Error('a MATCH always carries the reproduced print');
	const { print, deployedCommit } = reproduced;
	const written = await writeAttestation(directory, buildAttestation(print, deployedCommit));
	return { outcome: `reproduced MATCH, wrote ${written}`, written };
}

async function main(): Promise<number> {
	const { target, baseUrl, options } = parseArgs(process.argv.slice(2), USAGE, ['days', 'dir']);
	const through = requireDate(target);
	const days = Number(options.get('days') ?? '1');
	if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
	const directory = options.get('dir') ?? DEFAULT_DIRECTORY;
	let failures = 0;
	const written = new Set<string>();
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const date = addDays(through, -offset);
		if (date < FIRST_PRINT_DATE) continue;
		try {
			const day = await attestDay(baseUrl, directory, date);
			if (day.written !== null) written.add(day.written);
			console.log(`${date}: ${day.outcome}`);
		} catch (error) {
			failures += 1;
			console.log(`${date}: FAILED: ${describeError(error)}`);
		}
	}
	const invalid = await invalidProofs(directory, written);
	for (const problem of invalid) console.log(`INVALID PROOF: ${problem}`);
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
