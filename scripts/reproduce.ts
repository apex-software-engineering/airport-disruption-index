/**
 * Recomputes a published round or daily print from the public API and checks it.
 *
 *   npm run reproduce -- <roundId>      e.g. 2026-11-17T20:45Z
 *   npm run reproduce -- <YYYY-MM-DD>   a settled day: every round, then the print
 *   npm run reproduce -- --indicative <YYYY-MM-DD> [--dir attestations]
 *       an indicative ET day (never a settlement value): the print rebuilt from its rounds, then
 *       its receipts compared both ways with the verified v1 attestations of its UTC days, read
 *       from a checkout of the attestations branch (design §4); for the last day before a
 *       cutover, the slots in its transition interval against the gap pin instead
 *   options: --base-url https://airports.apexsofteng.com
 *
 * Prints MATCH, MISMATCH, PENDING or PARTIAL. Exit codes: 0 match, 1 mismatch, 2 could not verify
 * (unreachable, not found, or published under a methodology or feed adapter this checkout does not
 * include), 4 pending (an indicative day whose v1 references, or gap pin, are not verified yet),
 * 5 partial (the last day before a cutover, whose gap pin is absent).
 */
import { indicativeSeriesPublished } from '@/lib/index/indicative';
import { reproduce } from '@/lib/reproduce';

import { DEFAULT_BRANCH, DEFAULT_DIRECTORY } from './lib/attestations';
import { proveIndicativeDay } from './lib/indicative-proof';
import { getApi } from './lib/public-api';

const DEFAULT_BASE_URL = 'https://airports.apexsofteng.com';
// `--indicative` is always accepted, and advertised once the series is published. It proves a day
// only against production and the attestations checkout: a preview's prints are not the attested
// ones (MISMATCH, exit 1), and without a checkout it cannot verify (exit 2).
const USAGE = `usage: npm run reproduce -- ${indicativeSeriesPublished(new Date()) ? '[--indicative] ' : ''}<roundId|YYYY-MM-DD> [--base-url URL]${indicativeSeriesPublished(new Date()) ? ' [--dir attestations]' : ''}`;

type Args = { target: string; baseUrl: string; indicative: boolean; directory: string };

function parseArgs(argv: string[]): Args | null {
	const args = [...argv];
	const indicative = args.includes('--indicative');
	if (indicative) args.splice(args.indexOf('--indicative'), 1);
	const option = (name: string, fallback: string): string | null => {
		const flag = args.indexOf(name);
		if (flag < 0) return fallback;
		const value = args[flag + 1];
		if (value === undefined) return null;
		args.splice(flag, 2);
		return value;
	};
	const baseUrl = option('--base-url', DEFAULT_BASE_URL);
	// Only the indicative proof reads the attestations checkout.
	if (!indicative && args.includes('--dir')) return null;
	const directory = option('--dir', DEFAULT_DIRECTORY);
	const [target, ...rest] = args;
	if (baseUrl === null || directory === null || target === undefined || rest.length > 0)
		return null;
	return { target, baseUrl: baseUrl.replace(/\/+$/, ''), indicative, directory };
}

async function run(args: Args): Promise<number> {
	if (!args.indicative) {
		const outcome = await reproduce(args.target, args.baseUrl, getApi);
		for (const line of outcome.log) console.log(line);
		switch (outcome.kind) {
			case 'match':
				console.log('MATCH');
				return 0;
			case 'mismatch':
				console.log('MISMATCH');
				for (const problem of outcome.problems) console.log(`  - ${problem}`);
				return 1;
			case 'cannot_verify':
				console.error(`cannot verify: ${outcome.reason}`);
				return 2;
		}
	}
	const checkout = { directory: args.directory, branch: DEFAULT_BRANCH };
	const proof = await proveIndicativeDay(
		args.target,
		args.baseUrl,
		checkout,
		getApi,
		() => new Date(),
	);
	for (const line of proof.log) console.log(line);
	switch (proof.kind) {
		case 'match':
			console.log('MATCH');
			return 0;
		case 'mismatch':
			console.log('MISMATCH');
			for (const problem of proof.problems) console.log(`  - ${problem}`);
			return 1;
		case 'pending':
			console.log(`PENDING: ${proof.reason}`);
			return 4;
		case 'partial':
			console.log(
				`PARTIAL: the covered slots are equal both ways, and the gap pin is absent; ${proof.unpinned.length} gap receipts are unpinned`,
			);
			return 5;
		case 'cannot_verify':
			console.error(`cannot verify: ${proof.reason}`);
			return 2;
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args === null) {
		console.error(`cannot verify: ${USAGE}`);
		return 2;
	}
	try {
		return await run(args);
	} catch (error) {
		console.error(
			`cannot verify: unexpected error: ${error instanceof Error ? error.stack : String(error)}`,
		);
		return 2;
	}
}

void main().then((code) => {
	process.exitCode = code;
});
