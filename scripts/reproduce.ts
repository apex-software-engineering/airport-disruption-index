/**
 * Recomputes a published round or daily print from the public API and checks it.
 *
 *   npm run reproduce -- <roundId>      e.g. 2026-11-17T20:45Z
 *   npm run reproduce -- <YYYY-MM-DD>   a settled day: every round, then the print
 *   npm run reproduce -- --indicative <YYYY-MM-DD>   an indicative ET day (never a settlement value;
 *                                                    listed in the usage once the series is published)
 *   options: --base-url https://airports.apexsofteng.com
 *
 * Prints MATCH or MISMATCH. Exit codes: 0 match, 1 mismatch, 2 could not verify (unreachable,
 * not found, or published under a methodology or feed adapter this checkout does not include).
 */
import { indicativeSeriesPublished } from '@/lib/index/indicative';
import { reproduce, reproduceIndicative } from '@/lib/reproduce';

import { getApi } from './lib/public-api';

const DEFAULT_BASE_URL = 'https://airports.apexsofteng.com';
// `--indicative` always works (preview rehearsal); it is advertised once the series is published.
const USAGE = `usage: npm run reproduce -- ${indicativeSeriesPublished() ? '[--indicative] ' : ''}<roundId|YYYY-MM-DD> [--base-url URL]`;

function parseArgs(
	argv: string[],
): { target: string; baseUrl: string; indicative: boolean } | null {
	const args = [...argv];
	const indicative = args.includes('--indicative');
	if (indicative) args.splice(args.indexOf('--indicative'), 1);
	let baseUrl = DEFAULT_BASE_URL;
	const flag = args.indexOf('--base-url');
	if (flag >= 0) {
		const value = args[flag + 1];
		if (value === undefined) return null;
		baseUrl = value.replace(/\/+$/, '');
		args.splice(flag, 2);
	}
	const [target, ...rest] = args;
	return target === undefined || rest.length > 0 ? null : { target, baseUrl, indicative };
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args === null) {
		console.error(`cannot verify: ${USAGE}`);
		return 2;
	}
	try {
		const outcome = args.indicative
			? await reproduceIndicative(args.target, args.baseUrl, getApi)
			: await reproduce(args.target, args.baseUrl, getApi);
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
