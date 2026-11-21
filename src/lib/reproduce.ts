/**
 * Recomputes a published round or daily print from the public API and checks it. The CLI in
 * scripts/reproduce.ts prints the outcome; the logic lives here so tests can run it against the
 * API route handlers.
 *
 * Each receipt is verified under the methodology and feed adapter it records, and the print is
 * rebuilt under the methodology in effect on its day, so a day that mixes versions (and prints
 * `suspended`) reproduces like any other. An object recording a version this checkout does not
 * know cannot be verified here: check out a commit that includes it.
 */
import { z } from 'zod';

import { DEPLOYED_COMMIT_HEADER, parseDeployedCommit } from '@/lib/deployment';
import { adapterOf } from '@/lib/index/adapters';
import { methodologyOf } from '@/lib/index/methodology';
import {
	printSchema,
	receiptSchema,
	type DailyPrint,
	type RoundReceipt,
} from '@/lib/index/schemas';
import { parseRoundId, parseUtcDate, type UtcDate } from '@/lib/index/time';
import { dayResponseProblems, verifyPrint, verifyRound } from '@/lib/index/verify';

const CONCURRENCY = 8;

export type ReproduceOutcome =
	| { kind: 'match'; log: string[] }
	| { kind: 'mismatch'; log: string[]; problems: string[] }
	| { kind: 'cannot_verify'; log: string[]; reason: string };

export type Get = (url: string) => Promise<Response>;

/** The check could not run: unreachable, not found, or a version this checkout lacks. */
export class CannotVerify extends Error {}

/** The check ran and the data disagrees. */
export class Mismatch extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join('; '));
	}
}

/** The version fields read before full validation, which rejects versions it does not know. */
const recordedSchema = z.object({
	methodologyVersion: z.string(),
	parameterHash: z.string(),
	adapterVersion: z.string().optional(),
});

export async function reproduce(
	target: string,
	baseUrl: string,
	get: Get,
): Promise<ReproduceOutcome> {
	if (parseUtcDate(target) !== null)
		return (await reproduceSettledDay(target, baseUrl, get)).outcome;
	const log: string[] = [];
	return outcomeOf(log, async () => {
		if (parseRoundId(target) !== null)
			return reproduceRound(new PublicApi(baseUrl, get), target, log);
		throw new CannotVerify(
			`${target} is neither a round id (2026-11-17T20:45Z) nor a date (2026-11-17)`,
		);
	});
}

/**
 * Reproduces a settled day. On MATCH it also returns the print it reproduced and the deployed
 * commit named by that same response, which is what an attestation pins.
 */
export async function reproduceSettledDay(
	date: UtcDate,
	baseUrl: string,
	get: Get,
): Promise<{
	outcome: ReproduceOutcome;
	reproduced: { print: DailyPrint; deployedCommit: string | null } | null;
}> {
	const log: string[] = [];
	let reproduced: { print: DailyPrint; deployedCommit: string | null } | null = null;
	const outcome = await outcomeOf(log, async () => {
		const day = await reproduceDay(new PublicApi(baseUrl, get), date, log);
		reproduced = day.problems.length === 0 ? day : null;
		return day.problems;
	});
	return { outcome, reproduced: outcome.kind === 'match' ? reproduced : null };
}

async function outcomeOf(log: string[], run: () => Promise<string[]>): Promise<ReproduceOutcome> {
	try {
		const problems = await run();
		return problems.length > 0 ? { kind: 'mismatch', log, problems } : { kind: 'match', log };
	} catch (error) {
		if (error instanceof Mismatch) return { kind: 'mismatch', log, problems: error.problems };
		if (error instanceof CannotVerify) return { kind: 'cannot_verify', log, reason: error.message };
		throw error;
	}
}

/**
 * A settled day as the API serves it, checked for consistency: revisions numbered 1..n for that
 * date, `print` the last of them, and the deployed commit the response's header names (null when
 * the deployment could not say, or predates the header).
 */
export async function fetchSettledDay(
	baseUrl: string,
	date: UtcDate,
	get: Get,
): Promise<{ print: DailyPrint; revisions: DailyPrint[]; deployedCommit: string | null }> {
	const api = new PublicApi(baseUrl, get);
	const response = await api.fetch(`/api/v1/days/${date}`);
	const body: unknown = await response.json();
	const recorded = z.object({ print: recordedSchema }).safeParse(body);
	if (recorded.success) requireKnown(recorded.data.print, `print ${date}`);
	const daySchema = z.object({
		status: z.literal('settled'),
		print: printSchema,
		revisions: z.array(printSchema),
	});
	const day = daySchema.safeParse(body);
	if (!day.success)
		throw new Mismatch([`day ${date} fails its schema: ${z.prettifyError(day.error)}`]);
	const { print, revisions } = day.data;
	const problems = dayResponseProblems(date, print, revisions);
	if (problems.length > 0) throw new Mismatch(problems);
	return { print, revisions, deployedCommit: deployedCommitOf(response) };
}

function deployedCommitOf(response: Response): string | null {
	const header = response.headers.get(DEPLOYED_COMMIT_HEADER);
	if (header === null) return null;
	try {
		return parseDeployedCommit(header);
	} catch (error) {
		throw new Mismatch([
			`${DEPLOYED_COMMIT_HEADER}: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
}

class PublicApi {
	constructor(
		readonly baseUrl: string,
		readonly get: Get,
	) {}

	async fetch(path: string): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		const response = await this.get(url).catch((error: unknown) => {
			throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
		});
		if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
		return response;
	}

	/** A published object, after checking this checkout knows the versions it records. */
	async getRecorded<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
		const body: unknown = await (await this.fetch(path)).json();
		const recorded = recordedSchema.safeParse(body);
		if (recorded.success) requireKnown(recorded.data, what);
		const parsed = schema.safeParse(body);
		if (!parsed.success)
			throw new Mismatch([`${what} fails its schema: ${z.prettifyError(parsed.error)}`]);
		return parsed.data;
	}
}

function requireKnown(recorded: z.infer<typeof recordedSchema>, what: string): void {
	const { methodologyVersion, parameterHash, adapterVersion } = recorded;
	if (methodologyOf(methodologyVersion, parameterHash) === null) {
		throw new CannotVerify(
			`${what} was published under methodology ${methodologyVersion} (${parameterHash}), which this checkout does not include. Check out a commit that does.`,
		);
	}
	if (adapterOf(adapterVersion) === null) {
		throw new CannotVerify(
			`${what} was parsed by feed adapter ${adapterVersion}, which this checkout does not include.`,
		);
	}
}

async function fetchRound(
	api: PublicApi,
	id: string,
): Promise<{ receipt: RoundReceipt; problems: string[] }> {
	const path = `/api/v1/rounds/${id}`;
	const receipt = await api.getRecorded(path, receiptSchema, `round ${id}`);
	if (receipt.roundId !== id)
		throw new Mismatch([`asked for round ${id}, got a receipt for ${receipt.roundId}`]);
	const raw =
		receipt.rawSha256 === null
			? null
			: new Uint8Array(await (await api.fetch(`${path}/raw`)).arrayBuffer());
	return { receipt, problems: verifyRound(receipt, raw).map((p) => `${id}: ${p}`) };
}

async function reproduceRound(api: PublicApi, id: string, log: string[]): Promise<string[]> {
	const { receipt, problems } = await fetchRound(api, id);
	log.push(`round ${id}: ${receipt.observation.status}, receiptHash ${receipt.receiptHash}`);
	return problems;
}

async function reproduceDay(
	api: PublicApi,
	date: UtcDate,
	log: string[],
): Promise<{ print: DailyPrint; deployedCommit: string | null; problems: string[] }> {
	const { print, deployedCommit } = await fetchSettledDay(api.baseUrl, date, api.get);
	const ids = print.rounds.map((r) => r.roundId);
	const results: { receipt: RoundReceipt; problems: string[] }[] = [];
	for (let i = 0; i < ids.length; i += CONCURRENCY) {
		results.push(
			...(await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => fetchRound(api, id)))),
		);
	}
	log.push(
		`print ${date} r${print.revision}: ${print.result.status}, ${ids.length} rounds, printHash ${print.printHash}`,
	);
	const problems = [
		...results.flatMap((r) => r.problems),
		...verifyPrint(
			print,
			results.map((r) => r.receipt),
		),
	];
	return { print, deployedCommit, problems };
}
