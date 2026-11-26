/**
 * The notice readback (design §2): N, the instant a methodology notice is first shown to be public,
 * from one read of the incidents page and `/api/v1/methodology` over the public internet. A run
 * either shows both (the incidents entry's headline, and the `upcoming` block naming the release's
 * version and parameter hash) and yields the one write-once record, or shows neither and yields
 * nothing: a failed run writes nothing and is simply run again.
 *
 * N = max(each response's `Date` header, the run's `run_started_at`, the runner's own clock once
 * both responses are in), so N is never before the notice was seen. The record names the run (id
 * and attempt), and the two response bodies are kept beside it, each hashed in it, so stamping the
 * record with OpenTimestamps covers them too; the step-2 registry change reads N and its proof's
 * block time B from it.
 */
import { z } from 'zod';

import { DEPLOYED_COMMIT_HEADER, parseDeployedCommit } from '@/lib/deployment';
import { sha256Hex } from '@/lib/index/json';
import type { Methodology } from '@/lib/index/methodology';
import { commitShaSchema } from '@/lib/index/schemas';
import { CannotVerify, Mismatch, type Get } from '@/lib/reproduce';

export const READBACK_SCHEMA = 'adi.notice-readback/1';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const readbackSchema = z.object({
	schema: z.literal(READBACK_SCHEMA),
	methodologyVersion: z.string(),
	parameterHash: hex64,
	/** The GitHub Actions run that read the notice back. */
	run: z.object({
		id: z.number().int().positive(),
		attempt: z.number().int().positive(),
		/** GitHub's `run_started_at`. */
		startedAt: z.iso.datetime(),
		/** The runner's own clock once both responses were in. */
		observedAt: z.iso.datetime(),
	}),
	/** The incidents page, then `/api/v1/methodology`, as received. */
	responses: z
		.array(
			z.object({
				url: z.url(),
				/** The response's `Date` header, verbatim. */
				date: z.string(),
				/** The response's `X-Deployed-Commit`: a production deployment always names one. */
				deployedCommit: commitShaSchema,
				/** The file beside the record that holds the body, byte for byte. */
				body: z.string(),
				bodySha256: hex64,
			}),
		)
		.length(2),
	/** N: the latest of the `Date` headers, the run's start and the run's observation. */
	noticeAt: z.iso.datetime(),
});
export type NoticeReadback = z.infer<typeof readbackSchema>;

/**
 * The incidents-log headline announcing `release`, which the readback looks for on /incidents.
 * Only a zoned release is announced this way: its first day is a day in its zone.
 */
export function noticeHeadline(release: Methodology): string {
	const { day, version } = release.parameters;
	if (day === 'utc') throw new Error(`${version} has UTC days; no ET notice announces it`);
	return `methodology v${version} announced, effective ET day ${release.effectiveFrom}`;
}

/** What `/api/v1/methodology` states about a release announced but not yet in effect. */
const upcomingSchema = z.object({
	upcoming: z.object({ version: z.string(), parameterHash: z.string() }).nullable().optional(),
});

/**
 * How far a response's `Date` may sit outside this run's own observation of the request (the
 * runner's clock just before and just after it), beyond the header's one-second resolution. A
 * `Date` outside it is refused before anything is written: the record is write-once, so a false N
 * could never be corrected. A backdated `Date` cannot move the cutover bound in any case: it uses
 * max(N, B), and B, the block time of the record's proof, always follows the observation.
 */
export const DATE_SKEW_MS = 5 * 60_000;

/** A value from a response, quoted, so its text can never read as a log or workflow command. */
function shown(value: string): string {
	return JSON.stringify(value);
}

/** The run doing the readback: its id, its attempt and GitHub's `run_started_at`. */
export type ReadbackRun = { id: number; attempt: number; startedAt: Date };

/** The files beside `notices/{version}.readback.json` holding the two response bodies. */
export function readbackBodyNames(version: string): { incidents: string; methodology: string } {
	return {
		incidents: `${version}.readback.incidents.html`,
		methodology: `${version}.readback.methodology.json`,
	};
}

export type Readback =
	| {
			kind: 'recorded';
			record: NoticeReadback;
			/** Each response body, under the name the record gives it. */
			bodies: { name: string; bytes: Uint8Array }[];
	  }
	/** Not yet visible: nothing is written, and the next run tries again. */
	| { kind: 'not_public'; reasons: string[] };

/**
 * Reads the notice for `release` back from `baseUrl`, timing each request on `clock` (the runner's
 * own). Throws Mismatch when the site states the release under another parameter hash (the notice
 * is wrong, not late), and CannotVerify when a response lacks the evidence the record needs: a
 * `Date` inside this run's observation of it, and the deployment's commit; or when it was
 * redirected, so another origin's page can never stand for the site's.
 */
export async function readBackNotice(
	baseUrl: string,
	release: Methodology,
	run: ReadbackRun,
	clock: () => Date,
	get: Get,
): Promise<Readback> {
	const { version } = release.parameters;
	const incidents = await fetchPublic(`${baseUrl}/incidents`, clock, get);
	const methodology = await fetchPublic(`${baseUrl}/api/v1/methodology`, clock, get);
	const reasons: string[] = [];
	if (incidents.status !== 200) reasons.push(`${incidents.url} answered HTTP ${incidents.status}`);
	else if (!visibleTextOf(incidents.body).includes(noticeHeadline(release)))
		reasons.push(`${incidents.url} does not show "${noticeHeadline(release)}"`);
	if (methodology.status !== 200) {
		reasons.push(`${methodology.url} answered HTTP ${methodology.status}`);
	} else {
		const upcoming = upcomingSchema.safeParse(jsonOf(methodology.body));
		const stated = upcoming.success ? upcoming.data.upcoming : null;
		if (stated === null || stated === undefined || stated.version !== version) {
			reasons.push(`${methodology.url} has no upcoming block for ${version}`);
		} else if (stated.parameterHash !== release.parameterHash) {
			throw new Mismatch([
				`${methodology.url} states ${version} with parameter hash ${shown(stated.parameterHash)}, not ${release.parameterHash}`,
			]);
		}
	}
	if (reasons.length > 0) return { kind: 'not_public', reasons };
	const observedAt = clock();
	const names = readbackBodyNames(version);
	const responses = [
		{ ...incidents, name: names.incidents },
		{ ...methodology, name: names.methodology },
	];
	const noticeAt = new Date(
		Math.max(
			run.startedAt.getTime(),
			observedAt.getTime(),
			...responses.map((response) => response.dateMs),
		),
	);
	return {
		kind: 'recorded',
		record: readbackSchema.parse({
			schema: READBACK_SCHEMA,
			methodologyVersion: version,
			parameterHash: release.parameterHash,
			run: {
				id: run.id,
				attempt: run.attempt,
				startedAt: run.startedAt.toISOString(),
				observedAt: observedAt.toISOString(),
			},
			responses: responses.map(({ url, date, deployedCommit, body, name }) => ({
				url,
				date,
				deployedCommit,
				body: name,
				bodySha256: sha256Hex(body),
			})),
			noticeAt: noticeAt.toISOString(),
		}),
		bodies: responses.map(({ name, body }) => ({ name, bytes: body })),
	};
}

type Fetched = {
	url: string;
	status: number;
	date: string;
	dateMs: number;
	deployedCommit: string;
	body: Uint8Array;
};

async function fetchPublic(url: string, clock: () => Date, get: Get): Promise<Fetched> {
	const sent = clock().getTime();
	const response = await get(url).catch((error: unknown) => {
		throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
	});
	const received = clock().getTime();
	if (response.redirected || (response.url !== '' && response.url !== url)) {
		throw new CannotVerify(`${url} was redirected to ${shown(response.url)}`);
	}
	const date = response.headers.get('Date');
	const dateMs = date === null ? Number.NaN : Date.parse(date);
	if (date === null || Number.isNaN(dateMs))
		throw new CannotVerify(`${url} has no valid Date header (${shown(String(date))})`);
	// The header has one-second resolution, so a response may state the second it began in.
	if (dateMs < sent - DATE_SKEW_MS - 1000 || dateMs > received + DATE_SKEW_MS) {
		throw new CannotVerify(
			`${url} states Date ${shown(date)}, outside this run’s observation of it (${new Date(sent).toISOString()} to ${new Date(received).toISOString()}, ± ${DATE_SKEW_MS / 60_000} min)`,
		);
	}
	const commit = response.headers.get(DEPLOYED_COMMIT_HEADER);
	const deployedCommit = commit === null ? null : parseCommit(commit);
	if (deployedCommit === null)
		throw new CannotVerify(`${url} names no deployed commit (${shown(String(commit))})`);
	return {
		url,
		status: response.status,
		date,
		dateMs,
		deployedCommit,
		body: new Uint8Array(await response.arrayBuffer()),
	};
}

/** A deployed-commit header as a commit id, or null for 'unknown' or anything malformed. */
function parseCommit(value: string): string | null {
	try {
		return parseDeployedCommit(value);
	} catch {
		return null;
	}
}

/** A response body as JSON, or null when it is not JSON. */
function jsonOf(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		return null;
	}
}

/**
 * A page's visible text: comments and the contents of script, style, template and noscript
 * elements dropped (a page's hydration data repeats its text in scripts), then tags removed and
 * whitespace collapsed, so markup never splits a phrase.
 */
function visibleTextOf(html: Uint8Array): string {
	return new TextDecoder()
		.decode(html)
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<[^>]*>/g, '')
		.replace(/\s+/g, ' ');
}
