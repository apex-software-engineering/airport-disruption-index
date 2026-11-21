/**
 * The command-line side of the verifier scripts (attest, verify-attestation): arguments, exit
 * codes and HTTP. The checks themselves live in src/lib/reproduce.ts and src/lib/index.
 */
import { CannotVerify, Mismatch, fetchSettledDay } from '@/lib/reproduce';
import type { DailyPrint } from '@/lib/index/schemas';
import { parseUtcDate, type UtcDate } from '@/lib/index/time';

const DEFAULT_BASE_URL = 'https://airports.apexsofteng.com';

// Shared with src/lib/reproduce.ts, so its errors are recognised here. Exits 2 and 1.
export { CannotVerify, Mismatch };

/** The live print has no attestation. Exit 3. */
export class Unattested extends Error {}

/** Everything checked matches, but the proof's time cannot be proven yet. Exit 4. */
export class Pending extends Error {}

export type Args = { target: string; baseUrl: string; options: ReadonlyMap<string, string> };

/** `<target> [--base-url URL] [--name value ...]`, accepting only the named options. */
export function parseArgs(
	argv: string[],
	usage: string,
	optionNames: readonly string[] = [],
): Args {
	const options = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? '';
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const value = argv[i + 1];
		if (name !== 'base-url' && !optionNames.includes(name))
			throw new CannotVerify(`unknown option ${arg}; usage: ${usage}`);
		if (value === undefined) throw new CannotVerify(`${arg} needs a value`);
		options.set(name, value);
		i += 1;
	}
	const [target, ...rest] = positional;
	if (target === undefined || rest.length > 0) throw new CannotVerify(`usage: ${usage}`);
	const baseUrl = (options.get('base-url') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
	return { target, baseUrl, options };
}

/**
 * Runs a check from the command line and prints its outcome. Exit codes: 0 MATCH, 1 MISMATCH,
 * 2 could not verify, 3 UNATTESTED, 4 PENDING. `check` returns the problems it found; an empty
 * list is a match.
 */
export function runCheck(
	usage: string,
	check: (args: Args) => Promise<string[]>,
	optionNames: readonly string[] = [],
): void {
	const run = async (): Promise<number> => {
		try {
			const problems = await check(parseArgs(process.argv.slice(2), usage, optionNames));
			if (problems.length > 0) throw new Mismatch(problems);
			console.log('MATCH');
			return 0;
		} catch (error) {
			if (error instanceof Mismatch) {
				console.log('MISMATCH');
				for (const problem of error.problems) console.log(`  - ${problem}`);
				return 1;
			}
			if (error instanceof Unattested) {
				console.log(`UNATTESTED: ${error.message}`);
				return 3;
			}
			if (error instanceof Pending) {
				console.log(`PENDING: ${error.message}`);
				return 4;
			}
			console.error(`cannot verify: ${describeError(error)}`);
			return 2;
		}
	};
	void run().then((code) => {
		process.exitCode = code;
	});
}

export function describeError(error: unknown): string {
	if (error instanceof CannotVerify) return error.message;
	if (error instanceof Mismatch) return `mismatch: ${error.message}`;
	return `unexpected error: ${error instanceof Error ? error.stack : String(error)}`;
}

export function requireDate(target: string): UtcDate {
	if (parseUtcDate(target) === null) throw new CannotVerify(`${target} is not a date (2026-11-17)`);
	return target;
}

/** GET from the index API under check. Only these requests carry the preview bypass secret. */
export function getApi(url: string): Promise<Response> {
	// Optional: lets the script read a Vercel preview behind deployment protection.
	const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
	return request(url, bypass ? { 'x-vercel-protection-bypass': bypass } : {});
}

/** GET from a third party, such as a block explorer: never with the bypass secret. */
export function getPublic(url: string): Promise<Response> {
	return request(url, {});
}

function request(url: string, extraHeaders: Record<string, string>): Promise<Response> {
	return fetch(url, {
		headers: { 'User-Agent': 'airport-disruption-index-reproduce/1.0', ...extraHeaders },
	});
}

/** A settled day, checked for consistency; see fetchSettledDay. */
export function fetchDay(
	baseUrl: string,
	date: UtcDate,
): Promise<{ print: DailyPrint; revisions: DailyPrint[]; deployedCommit: string | null }> {
	return fetchSettledDay(baseUrl, date, getApi);
}
