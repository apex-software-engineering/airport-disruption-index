/**
 * The notice readback (design §2): N, the instant a methodology notice is first shown to be public,
 * from one read of the incidents page and `/api/v1/methodology` over the public internet. A run
 * either shows both (the incidents entry's headline, and the `upcoming` block naming the release's
 * version and parameter hash) and yields the one write-once record, or shows neither and yields
 * nothing: a failed run writes nothing and is simply run again.
 *
 * N = max(each response's `Date` header, the run's `run_started_at`), so no clock of ours can make
 * it earlier. The record is stamped with OpenTimestamps like a print; the step-2 registry change
 * reads N and its proof's block time B from it.
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
	run: z.object({ id: z.number().int().positive(), startedAt: z.iso.datetime() }),
	/** The incidents page, then `/api/v1/methodology`, as received. */
	responses: z
		.array(
			z.object({
				url: z.url(),
				/** The response's `Date` header, verbatim. */
				date: z.string(),
				deployedCommit: commitShaSchema.nullable(),
				bodySha256: hex64,
			}),
		)
		.length(2),
	/** N: the latest of the `Date` headers and the run's start. */
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

/** The run doing the readback: its id and GitHub's `run_started_at`. */
export type ReadbackRun = { id: number; startedAt: Date };

export type Readback =
	| { kind: 'recorded'; record: NoticeReadback }
	/** Not yet visible: nothing is written, and the next run tries again. */
	| { kind: 'not_public'; reasons: string[] };

/**
 * Reads the notice for `release` back from `baseUrl`. Throws Mismatch when the site states the
 * release under another parameter hash (the notice is wrong, not late), and CannotVerify when a
 * response lacks the evidence the record needs (a `Date` header).
 */
export async function readBackNotice(
	baseUrl: string,
	release: Methodology,
	run: ReadbackRun,
	get: Get,
): Promise<Readback> {
	const { version } = release.parameters;
	const incidents = await fetchPublic(`${baseUrl}/incidents`, get);
	const methodology = await fetchPublic(`${baseUrl}/api/v1/methodology`, get);
	const reasons: string[] = [];
	if (incidents.status !== 200) reasons.push(`${incidents.url} answered HTTP ${incidents.status}`);
	else if (!textOf(incidents.body).includes(noticeHeadline(release)))
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
				`${methodology.url} states ${version} with parameter hash ${stated.parameterHash}, not ${release.parameterHash}`,
			]);
		}
	}
	if (reasons.length > 0) return { kind: 'not_public', reasons };
	const responses = [incidents, methodology];
	const noticeAt = new Date(
		Math.max(run.startedAt.getTime(), ...responses.map((response) => response.dateMs)),
	);
	return {
		kind: 'recorded',
		record: readbackSchema.parse({
			schema: READBACK_SCHEMA,
			methodologyVersion: version,
			parameterHash: release.parameterHash,
			run: { id: run.id, startedAt: run.startedAt.toISOString() },
			responses: responses.map(({ url, date, deployedCommit, body }) => ({
				url,
				date,
				deployedCommit,
				bodySha256: sha256Hex(body),
			})),
			noticeAt: noticeAt.toISOString(),
		}),
	};
}

type Fetched = {
	url: string;
	status: number;
	date: string;
	dateMs: number;
	deployedCommit: string | null;
	body: Uint8Array;
};

async function fetchPublic(url: string, get: Get): Promise<Fetched> {
	const response = await get(url).catch((error: unknown) => {
		throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
	});
	const date = response.headers.get('Date');
	const dateMs = date === null ? Number.NaN : Date.parse(date);
	if (date === null || Number.isNaN(dateMs))
		throw new CannotVerify(`${url} has no valid Date header (${String(date)})`);
	const commit = response.headers.get(DEPLOYED_COMMIT_HEADER);
	return {
		url,
		status: response.status,
		date,
		dateMs,
		deployedCommit: commit === null ? null : parseDeployedCommit(commit),
		body: new Uint8Array(await response.arrayBuffer()),
	};
}

/** A response body as JSON, or null when it is not JSON. */
function jsonOf(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(body));
	} catch {
		return null;
	}
}

/** A page's visible text: tags removed and whitespace collapsed, so markup never splits a phrase. */
function textOf(html: Uint8Array): string {
	return new TextDecoder()
		.decode(html)
		.replace(/<[^>]*>/g, '')
		.replace(/\s+/g, ' ');
}
