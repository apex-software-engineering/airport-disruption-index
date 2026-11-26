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
import { publishBy, settlementDay, settlesAt } from '@/lib/index/calendar';
import { admits, methodologyOf, type Identity } from '@/lib/index/methodology';
import { receiptHashMatches } from '@/lib/index/round';
import {
	indicativePrintSchema,
	printSchema,
	receiptSchema,
	receiptShapeSchema,
	type DailyPrint,
	type IndicativePrint,
	type RoundReceipt,
} from '@/lib/index/schemas';
import { parseRoundId, parseUtcDate, type UtcDate } from '@/lib/index/time';
import {
	dayResponseProblems,
	verifyIndicativePrint,
	verifyPrint,
	verifyRound,
} from '@/lib/index/verify';

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
	const log: string[] = [];
	const api = new PublicApi(baseUrl, get);
	return outcomeOf(log, async () => {
		if (parseRoundId(target) !== null) return reproduceRound(api, target, log);
		if (parseUtcDate(target) !== null)
			return reproduceDay(api, await fetchSettledDay(baseUrl, target, get), log);
		throw new CannotVerify(
			`${target} is neither a round id (2026-11-17T20:45Z) nor a date (2026-11-17)`,
		);
	});
}

/**
 * Reproduces the indicative ET print of `date` (design §4) from the public API: every round it
 * lists, then the print, rebuilt under the release its date gives the indicative series.
 */
export async function reproduceIndicative(
	date: UtcDate,
	baseUrl: string,
	get: Get,
): Promise<ReproduceOutcome> {
	return (await reproduceIndicativeDay(date, baseUrl, get)).outcome;
}

/** `reproduceIndicative`, with the print it checked once the API served one. */
export async function reproduceIndicativeDay(
	date: UtcDate,
	baseUrl: string,
	get: Get,
): Promise<{ outcome: ReproduceOutcome; print: IndicativePrint | null }> {
	const log: string[] = [];
	const api = new PublicApi(baseUrl, get);
	let served: IndicativePrint | null = null;
	const outcome = await outcomeOf(log, async () => {
		if (parseUtcDate(date) === null) throw new CannotVerify(`${date} is not a date (2026-11-20)`);
		const { print } = await api.getRecorded(
			`/api/v1/indicative/days/${date}`,
			z.object({
				standing: z.literal('indicative'),
				date: z.literal(date),
				print: indicativePrintSchema,
			}),
			`indicative day ${date}`,
			(body) => z.object({ print: recordedSchema }).safeParse(body).data?.print,
		);
		// The print must be the requested day's before anything it lists is trusted or fetched.
		if (print.date !== date) {
			throw new Mismatch([`asked for indicative day ${date}, got the print of ${print.date}`]);
		}
		served = print;
		const results = await fetchRounds(
			print.rounds.map((r) => r.roundId),
			(id) => fetchIndicativeRound(api, date, id, print.admission.accepts),
		);
		log.push(
			`indicative ${print.date} (ET): ${print.result.status}, ${print.rounds.length} rounds, printHash ${print.printHash}`,
		);
		return [
			...results.flatMap((r) => r.problems),
			...verifyIndicativePrint(
				print,
				results.map((r) => r.receipt),
			),
		];
	});
	return { outcome, print: served };
}

/**
 * Reproduces a settled day already fetched with fetchSettledDay, from the receipts its print
 * lists. An attestation is built from that same response, so nothing is fetched twice.
 */
export function reproduceFetchedDay(
	day: SettledDay,
	baseUrl: string,
	get: Get,
): Promise<ReproduceOutcome> {
	const log: string[] = [];
	return outcomeOf(log, () => reproduceDay(new PublicApi(baseUrl, get), day, log));
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
export type SettledDay = {
	print: DailyPrint;
	revisions: DailyPrint[];
	deployedCommit: string | null;
};

export async function fetchSettledDay(
	baseUrl: string,
	date: UtcDate,
	get: Get,
): Promise<SettledDay> {
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

/** Whether a day's print is out, or, while it is not, whether its publication deadline passed. */
export type Publication =
	{ kind: 'settled' } | { kind: 'not_yet_due' | 'overdue'; publishBy: string };

const unsettledSchema = z.object({ status: z.literal('unsettled'), publishBy: z.iso.datetime() });

/**
 * A day's publication state at `now`, from `/api/v1/days/{date}`. Its cutoff and deadline are this
 * checkout's own (`settlesAt` and `publishBy` of the release that owns the date), never the
 * server's: the server is the party checked. A day served as settled before its cutoff was built
 * before admission closed, and is a mismatch. An unsettled day answers 404 stating its
 * `publishBy`; one that states another deadline is a mismatch, since a later one could hide an
 * overdue print. Anything else that is not a settled day cannot be judged.
 *
 * The server answered at some instant between the request's start and its end, both read from
 * `clock`, so each verdict takes the edge that makes it certain: settled is premature only if the
 * request ended before the cutoff, and unsettled is overdue only if it started at the deadline.
 */
export async function fetchPublication(
	baseUrl: string,
	date: UtcDate,
	clock: () => Date,
	get: Get,
): Promise<Publication> {
	const url = `${baseUrl}/api/v1/days/${date}`;
	const started = clock();
	const response = await get(url).catch((error: unknown) => {
		throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
	});
	const ended = clock();
	const { window } = settlementDay(date);
	if (response.ok) {
		const cutoff = settlesAt(window);
		if (ended < cutoff) {
			throw new Mismatch([
				`${date} is served as settled at ${ended.toISOString()}, before its cutoff ${cutoff.toISOString()}`,
			]);
		}
		return { kind: 'settled' };
	}
	const unsettled = unsettledSchema.safeParse(await response.json().catch(() => null));
	if (response.status !== 404 || !unsettled.success)
		throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
	const deadline = publishBy(window);
	if (unsettled.data.publishBy !== deadline.toISOString()) {
		throw new Mismatch([
			`${url} states publishBy ${unsettled.data.publishBy}, not ${deadline.toISOString()}`,
		]);
	}
	return {
		kind: started < deadline ? 'not_yet_due' : 'overdue',
		publishBy: deadline.toISOString(),
	};
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
		private readonly baseUrl: string,
		private readonly get: Get,
	) {}

	async fetch(path: string): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		const response = await this.get(url).catch((error: unknown) => {
			throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
		});
		if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
		return response;
	}

	/**
	 * A published object, after checking this checkout knows the versions it records. `recordOf`
	 * finds them in the body when they are not at its top level.
	 */
	async getRecorded<T>(
		path: string,
		schema: z.ZodType<T>,
		what: string,
		recordOf: (body: unknown) => unknown = (body) => body,
	): Promise<T> {
		const body: unknown = await (await this.fetch(path)).json();
		return parseRecorded(body, schema, what, recordOf);
	}
}

/** A published body, after checking this checkout knows the versions it records. */
function parseRecorded<T>(
	body: unknown,
	schema: z.ZodType<T>,
	what: string,
	recordOf: (body: unknown) => unknown = (b) => b,
): T {
	const recorded = recordedSchema.safeParse(recordOf(body));
	if (recorded.success) requireKnown(recorded.data, what);
	const parsed = schema.safeParse(body);
	if (!parsed.success)
		throw new Mismatch([`${what} fails its schema: ${z.prettifyError(parsed.error)}`]);
	return parsed.data;
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

type FetchedRound = { receipt: RoundReceipt; problems: string[] };

async function fetchRound(api: PublicApi, id: string): Promise<FetchedRound> {
	const path = `/api/v1/rounds/${id}`;
	return verifyFetchedRound(api, id, await (await api.fetch(path)).json());
}

/**
 * A round an indicative print lists. One under an identity its admission accepts is verified in
 * full, rebuilt from its body. Any other is foreign: it took no slot, so it is checked by shape
 * and hash alone, which keeps a day suspended by a receipt from a release this checkout does not
 * know reproducible (the rebuilt print then states why it is suspended).
 */
async function fetchIndicativeRound(
	api: PublicApi,
	date: string,
	id: string,
	accepts: readonly Identity[],
): Promise<FetchedRound> {
	// Scoped to the print: the only endpoint that serves a foreign receipt, and only as its evidence.
	const body: unknown = await (
		await api.fetch(`/api/v1/indicative/days/${date}/rounds/${id}`)
	).json();
	const recorded = recordedSchema.safeParse(body);
	if (recorded.success && admits(accepts, recorded.data)) return verifyFetchedRound(api, id, body);
	const shape = receiptShapeSchema.safeParse(body);
	if (!shape.success)
		throw new Mismatch([`round ${id} fails its schema: ${z.prettifyError(shape.error)}`]);
	if (shape.data.roundId !== id)
		throw new Mismatch([`asked for round ${id}, got a receipt for ${shape.data.roundId}`]);
	const hashed = receiptHashMatches(shape.data);
	return {
		receipt: shape.data,
		problems: hashed ? [] : [`${id}: receiptHash does not match the receipt contents`],
	};
}

/** Checks a fetched receipt under the release and adapter it records, then rebuilds it. */
async function verifyFetchedRound(
	api: PublicApi,
	id: string,
	body: unknown,
): Promise<FetchedRound> {
	const path = `/api/v1/rounds/${id}`;
	const receipt = parseRecorded(body, receiptSchema, `round ${id}`);
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

/** Every round in `ids`, fetched and verified CONCURRENCY at a time, in order. */
async function fetchRounds(
	ids: readonly string[],
	fetchOne: (id: string) => Promise<FetchedRound>,
): Promise<FetchedRound[]> {
	const results: FetchedRound[] = [];
	for (let i = 0; i < ids.length; i += CONCURRENCY) {
		results.push(...(await Promise.all(ids.slice(i, i + CONCURRENCY).map(fetchOne))));
	}
	return results;
}

async function reproduceDay(api: PublicApi, day: SettledDay, log: string[]): Promise<string[]> {
	const { print } = day;
	const ids = print.rounds.map((r) => r.roundId);
	const results = await fetchRounds(ids, (id) => fetchRound(api, id));
	log.push(
		`print ${print.date} r${print.revision}: ${print.result.status}, ${ids.length} rounds, printHash ${print.printHash}`,
	);
	return [
		...results.flatMap((r) => r.problems),
		...verifyPrint(
			print,
			results.map((r) => r.receipt),
		),
	];
}
