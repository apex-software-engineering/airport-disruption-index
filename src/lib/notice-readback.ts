/**
 * The notice readback (design §2): N, the instant a methodology notice is first shown to be public,
 * from one read of the incidents page, the methodology page and `/api/v1/methodology` over the
 * public internet. A run either sees all three (the incidents entry's dated headline and the
 * release's hash, the release's rules heading, and the `upcoming` block naming the release's
 * version and hash) and yields the one write-once record, or yields nothing: a failed run writes
 * nothing and is simply run again.
 *
 * N = max(each response's `Date` header, the run's `run_started_at`, the runner's own clock once
 * all responses are in), so N is never before the notice was seen. The record names the run (id
 * and attempt), and the three response bodies are kept beside it, each hashed in it, so stamping
 * the record with OpenTimestamps covers them too; the step-2 registry change reads N and its
 * proof's block time B from it.
 */
import { htmlToDOM, type Element } from 'html-react-parser';
import { z } from 'zod';

import { DEPLOYED_COMMIT_HEADER, parseDeployedCommit } from '@/lib/deployment';
import { sha256Hex } from '@/lib/index/json';
import type { Methodology } from '@/lib/index/methodology';
import { commitShaSchema } from '@/lib/index/schemas';
import { utcDateOf } from '@/lib/index/time';
import { CannotVerify, Mismatch, type Get } from '@/lib/reproduce';

export const READBACK_SCHEMA = 'adi.notice-readback/1';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** An HTTP-date in RFC 9110's preferred IMF-fixdate form, always GMT: e.g. Sat, 28 Nov 2026 15:00:05 GMT. */
const IMF_FIXDATE =
	/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

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
	/** The incidents page, the methodology page, then `/api/v1/methodology`, as received. */
	responses: z
		.array(
			z.object({
				url: z.url(),
				/** The runner's clock just before the request was sent. */
				requestedAt: z.iso.datetime(),
				/** The runner's clock just after the response arrived. */
				receivedAt: z.iso.datetime(),
				/** The response's `Date` header, verbatim: an IMF-fixdate within DATE_BEHIND_MS before and DATE_AHEAD_MS after the two. */
				date: z.string().regex(IMF_FIXDATE),
				/** The response's `X-Deployed-Commit`: a production deployment always names one. */
				deployedCommit: commitShaSchema,
				/** The file beside the record that holds the body, byte for byte. */
				body: z.string(),
				bodySha256: hex64,
			}),
		)
		.length(3),
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
	if (release.noticePublishedAt === null) throw new Error(`${version} has no notice instant`);
	return `${noticeDate(release)}: methodology v${version} announced, effective ET day ${release.effectiveFrom}`;
}

/**
 * The UTC date a release's notice is published on, which its incidents entry and its Version
 * history line state: derived from `noticePublishedAt`, so a moved instant fails the docs test and
 * the readback until the text moves with it.
 */
export function noticeDate(release: Methodology): string {
	if (release.noticePublishedAt === null) {
		throw new Error(`${release.parameters.version} has no notice instant`);
	}
	return utcDateOf(new Date(release.noticePublishedAt));
}

/** The heading the methodology page shows a release's rules under, once its notice is out. */
export function rulesHeading(release: Methodology): string {
	return `Settlement rules, v${release.parameters.version}`;
}

/** What `/api/v1/methodology` states about a release announced but not yet in effect. */
const upcomingSchema = z.object({
	upcoming: z.object({ version: z.string(), parameterHash: z.string() }).nullable().optional(),
});

/**
 * How far a response's `Date` may sit outside this run's own observation of the request (the
 * runner's clock just before and just after it), beyond the header's one-second resolution. A
 * `Date` outside it is refused before anything is written: the record is write-once, so a false N
 * could never be corrected. Ahead of the observation only clock skew is allowed, since a later
 * `Date` would move N later. Behind it an edge cache's copy is allowed (its `Date` is when the
 * origin made it): an earlier `Date` can never move N earlier than the run's own observation,
 * which N includes, nor the cutover bound, which uses max(N, B).
 */
export const DATE_AHEAD_MS = 5 * 60_000;
export const DATE_BEHIND_MS = 60 * 60_000;

/** A value from a response, quoted, so its text can never read as a log or workflow command. */
function shown(value: string): string {
	return JSON.stringify(value);
}

/** The run doing the readback: its id, its attempt and GitHub's `run_started_at`. */
export type ReadbackRun = { id: number; attempt: number; startedAt: Date };

/** The files beside `notices/{version}.readback.json` holding the two response bodies. */
export function readbackBodyNames(version: string): {
	incidents: string;
	rules: string;
	methodology: string;
} {
	return {
		incidents: `${version}.readback.incidents.html`,
		rules: `${version}.readback.methodology.html`,
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
	const rules = await fetchPublic(`${baseUrl}/methodology`, clock, get);
	const methodology = await fetchPublic(`${baseUrl}/api/v1/methodology`, clock, get);
	const reasons: string[] = [];
	// The rendered entry (its dated headline and the release's hash), and the rules it publishes.
	reasons.push(...pageShows(incidents, [noticeHeadline(release), release.parameterHash]));
	reasons.push(...pageShows(rules, [rulesHeading(release)]));
	if (methodology.status !== 200) {
		reasons.push(`${methodology.url} answered HTTP ${methodology.status}`);
	} else if (methodology.contentType !== 'application/json') {
		reasons.push(`${methodology.url} is ${shown(methodology.contentType)}, not JSON`);
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
		{ ...rules, name: names.rules },
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
			responses: responses.map(({ url, sent, received, date, deployedCommit, body, name }) => ({
				url,
				requestedAt: new Date(sent).toISOString(),
				receivedAt: new Date(received).toISOString(),
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

/** Why `page` is not an HTML page whose visible text holds every `required` phrase; none if it is. */
function pageShows(page: Fetched, required: readonly string[]): string[] {
	if (page.status !== 200) return [`${page.url} answered HTTP ${page.status}`];
	if (page.contentType !== 'text/html')
		return [`${page.url} is ${shown(page.contentType)}, not an HTML page`];
	const text = visibleTextOf(page.body);
	return required
		.filter((phrase) => !text.includes(phrase))
		.map((phrase) => `${page.url} does not show "${phrase}"`);
}

type Fetched = {
	url: string;
	/** The runner's clock just before the request and just after the response, in ms. */
	sent: number;
	received: number;
	status: number;
	/** The media type, without parameters, lower-cased. */
	contentType: string;
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
	if (response.status >= 300 && response.status < 400) {
		throw new CannotVerify(
			`${url} answered a redirect (HTTP ${response.status}) to ${shown(String(response.headers.get('Location')))}`,
		);
	}
	if (response.redirected || (response.url !== '' && response.url !== url)) {
		throw new CannotVerify(`${url} was redirected to ${shown(response.url)}`);
	}
	const date = response.headers.get('Date');
	if (date === null || !IMF_FIXDATE.test(date))
		throw new CannotVerify(`${url} states Date ${shown(String(date))}, which is not an HTTP-date`);
	const dateMs = Date.parse(date);
	// The header has one-second resolution, so a response may state the second it began in.
	if (dateMs < sent - DATE_BEHIND_MS - 1000 || dateMs > received + DATE_AHEAD_MS) {
		throw new CannotVerify(
			`${url} states Date ${shown(date)}, outside this run’s observation of it (${new Date(sent).toISOString()} to ${new Date(received).toISOString()}, up to ${DATE_BEHIND_MS / 60_000} min before or ${DATE_AHEAD_MS / 60_000} min after)`,
		);
	}
	const commit = response.headers.get(DEPLOYED_COMMIT_HEADER);
	const deployedCommit = commit === null ? null : parseCommit(commit);
	if (deployedCommit === null)
		throw new CannotVerify(`${url} names no deployed commit (${shown(String(commit))})`);
	return {
		url,
		sent,
		received,
		status: response.status,
		contentType:
			(response.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
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

/** Elements whose content is never rendered as page text. */
const UNRENDERED = new Set(['head', 'title', 'script', 'style', 'template', 'noscript', 'iframe']);

/** Tailwind's hiding classes, which this site's pages use. */
const HIDING_CLASSES = new Set(['hidden', 'invisible', 'sr-only']);

/** Whether an element, and so all it holds, is hidden from a reader of the page. */
function isHidden(element: Element): boolean {
	if (UNRENDERED.has(element.name) || 'hidden' in element.attribs) return true;
	const style = (element.attribs.style ?? '').replace(/\s+/g, '').toLowerCase();
	if (/(^|;)(display:none|visibility:hidden|content-visibility:hidden)/.test(style)) return true;
	return (element.attribs.class ?? '').split(/\s+/).some((name) => HIDING_CLASSES.has(name));
}

/**
 * A page's visible text, from its parsed HTML (html-react-parser's parser, which decodes
 * entities): only text nodes outside hidden or unrendered elements, never comments or attribute
 * values, whitespace collapsed so markup never splits a phrase. Nodes are told apart by DOM
 * `nodeType` (1 element, 3 text), never `instanceof`: the package's two builds have separate
 * node classes.
 */
function visibleTextOf(html: Uint8Array): string {
	const parts: string[] = [];
	const walk = (nodes: Element['children']) => {
		for (const node of nodes) {
			if (node.nodeType === 3) parts.push(node.data);
			else if (node.nodeType === 1 && 'attribs' in node && !isHidden(node)) walk(node.children);
		}
	};
	walk(htmlToDOM(new TextDecoder().decode(html)));
	return parts.join('').replace(/\s+/g, ' ');
}
