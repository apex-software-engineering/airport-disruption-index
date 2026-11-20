/**
 * Recomputes a published round or daily print from the public API and checks it.
 *
 *   npm run reproduce -- <roundId>      e.g. 2026-11-17T20:45Z
 *   npm run reproduce -- <YYYY-MM-DD>   a settled day: every round, then the print
 *   options: --base-url https://airports.apexsofteng.com
 *
 * Prints MATCH or MISMATCH. Exit codes: 0 match, 1 mismatch, 2 could not verify (unreachable,
 * not found, or published under a methodology version other than this checkout's).
 */
import { z } from 'zod';

import { METHODOLOGY } from '@/lib/index/methodology';
import { printSchema, receiptSchema, type RoundReceipt } from '@/lib/index/schemas';
import { parseRoundId, parseUtcDate } from '@/lib/index/time';
import { verifyPrint, verifyRound } from '@/lib/index/verify';

const DEFAULT_BASE_URL = 'https://airports.apexsofteng.com';
const CONCURRENCY = 8;

class CannotVerify extends Error {}

function parseArgs(argv: string[]): { target: string; baseUrl: string } {
	const args = [...argv];
	let baseUrl = DEFAULT_BASE_URL;
	const flag = args.indexOf('--base-url');
	if (flag >= 0) {
		const value = args[flag + 1];
		if (value === undefined) throw new CannotVerify('--base-url needs a value');
		baseUrl = value.replace(/\/+$/, '');
		args.splice(flag, 2);
	}
	const [target, ...rest] = args;
	if (target === undefined || rest.length > 0) {
		throw new CannotVerify('usage: npm run reproduce -- <roundId|YYYY-MM-DD> [--base-url URL]');
	}
	return { target, baseUrl };
}

async function get(url: string): Promise<Response> {
	const headers: Record<string, string> = {
		'User-Agent': 'airport-disruption-index-reproduce/1.0',
	};
	// Optional: lets the script read a Vercel preview behind deployment protection.
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
	if (bypass) headers['x-vercel-protection-bypass'] = bypass;
	const response = await fetch(url, { headers }).catch((error: unknown) => {
		throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
	});
	if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
	return response;
}

async function getJson<T>(url: string, schema: z.ZodType<T>, what: string): Promise<T> {
	const parsed = schema.safeParse(await (await get(url)).json());
	if (!parsed.success)
		throw new Mismatch([`${what} fails its schema: ${z.prettifyError(parsed.error)}`]);
	return parsed.data;
}

class Mismatch extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join('; '));
	}
}

function requireVersion(version: string, what: string): void {
	if (version !== METHODOLOGY.version) {
		throw new CannotVerify(
			`${what} was published under methodology ${version}; this checkout is ${METHODOLOGY.version}. Check out the commit that released ${version}.`,
		);
	}
}

async function fetchRound(
	baseUrl: string,
	id: string,
): Promise<{ receipt: RoundReceipt; problems: string[] }> {
	const url = `${baseUrl}/api/v1/rounds/${id}`;
	const receipt = await getJson(url, receiptSchema, `receipt ${id}`);
	// A receipt for some other round is a mismatch whatever its version; verifyRound reports it.
	if (receipt.roundId === id) requireVersion(receipt.methodologyVersion, `round ${id}`);
	const raw =
		receipt.rawSha256 === null
			? null
			: new Uint8Array(await (await get(`${url}/raw`)).arrayBuffer());
	return { receipt, problems: verifyRound(receipt, raw, id).map((p) => `${id}: ${p}`) };
}

async function reproduceRound(baseUrl: string, id: string): Promise<string[]> {
	const { receipt, problems } = await fetchRound(baseUrl, id);
	console.log(`round ${id}: ${receipt.observation.status}, receiptHash ${receipt.receiptHash}`);
	return problems;
}

async function reproduceDay(baseUrl: string, date: string): Promise<string[]> {
	const daySchema = z.object({ status: z.literal('settled'), print: printSchema });
	const { print } = await getJson(`${baseUrl}/api/v1/days/${date}`, daySchema, `day ${date}`);
	if (print.date === date) requireVersion(print.methodologyVersion, `print ${date}`);
	const ids = print.rounds.map((r) => r.roundId);
	const results: { receipt: RoundReceipt; problems: string[] }[] = [];
	for (let i = 0; i < ids.length; i += CONCURRENCY) {
		results.push(
			...(await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => fetchRound(baseUrl, id)))),
		);
	}
	console.log(
		`print ${date} r${print.revision}: ${print.result.status}, ${ids.length} rounds, printHash ${print.printHash}`,
	);
	return [
		...results.flatMap((r) => r.problems),
		...verifyPrint(
			print,
			results.map((r) => r.receipt),
			date,
		),
	];
}

async function main(): Promise<number> {
	try {
		const { target, baseUrl } = parseArgs(process.argv.slice(2));
		let problems: string[];
		if (parseRoundId(target) !== null) problems = await reproduceRound(baseUrl, target);
		else if (parseUtcDate(target) !== null) problems = await reproduceDay(baseUrl, target);
		else
			throw new CannotVerify(
				`${target} is neither a round id (2026-11-17T20:45Z) nor a date (2026-11-17)`,
			);
		if (problems.length > 0) throw new Mismatch(problems);
		console.log('MATCH');
		return 0;
	} catch (error) {
		if (error instanceof Mismatch) {
			console.log('MISMATCH');
			for (const problem of error.problems) console.log(`  - ${problem}`);
			return 1;
		}
		if (error instanceof CannotVerify) {
			console.error(`cannot verify: ${error.message}`);
			return 2;
		}
		console.error(
			`cannot verify: unexpected error: ${error instanceof Error ? error.stack : String(error)}`,
		);
		return 2;
	}
}

void main().then((code) => {
	process.exitCode = code;
});
