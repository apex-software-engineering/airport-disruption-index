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

/**
 * An instant as `toISOString` writes it, UTC with exactly milliseconds (2026-11-29T00:20:05.000Z),
 * so it parses to itself: no finer digits for JavaScript to truncate at a bound.
 */
const instant = z.iso.datetime({ precision: 3 });

export const readbackSchema = z.object({
	schema: z.literal(READBACK_SCHEMA),
	methodologyVersion: z.string(),
	parameterHash: hex64,
	/** The GitHub Actions run that read the notice back. */
	run: z.object({
		id: z.number().int().positive(),
		attempt: z.number().int().positive(),
		/** GitHub's `run_started_at`. */
		startedAt: instant,
		/** The runner's own clock once all three responses were in. */
		observedAt: instant,
	}),
	/** The incidents page, the methodology page, then `/api/v1/methodology`, as received. */
	responses: z
		.array(
			z.object({
				url: z.url(),
				/** The runner's clock just before the request was sent. */
				requestedAt: instant,
				/** The runner's clock just after the response arrived. */
				receivedAt: instant,
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
	noticeAt: instant,
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

/**
 * Whether a `Date` header (in ms) lies inside a run's observation of its request, from `sentMs`
 * to `receivedMs`: the readback refuses a response outside it, and the step-2 check replays it from
 * the record. The header has one-second resolution, so a response may state the second it began in.
 */
export function dateWithinObservation(dateMs: number, sentMs: number, receivedMs: number): boolean {
	return dateMs >= sentMs - DATE_BEHIND_MS - 1000 && dateMs <= receivedMs + DATE_AHEAD_MS;
}

/** The only site a readback record is ever for: N is when the production notice was public. */
export const READBACK_ORIGIN = 'https://airports.apexsofteng.com';

/** The three pages a readback reads, in the record's order. */
function readbackUrls(baseUrl: string): [incidents: string, rules: string, methodology: string] {
	return [`${baseUrl}/incidents`, `${baseUrl}/methodology`, `${baseUrl}/api/v1/methodology`];
}

/** A value from a response, quoted, so its text can never read as a log or workflow command. */
function shown(value: string): string {
	return JSON.stringify(value);
}

/** The run doing the readback: its id, its attempt and GitHub's `run_started_at`. */
export type ReadbackRun = { id: number; attempt: number; startedAt: Date };

/** Where a release's readback record sits on the attestations branch. */
export function readbackRecordName(version: string): string {
	return `notices/${version}.readback.json`;
}

/** The files beside `notices/{version}.readback.json` holding the three response bodies. */
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
	const [incidentsUrl, rulesUrl, methodologyUrl] = readbackUrls(baseUrl);
	const incidents = await fetchPublic(incidentsUrl, clock, get);
	const rules = await fetchPublic(rulesUrl, clock, get);
	const methodology = await fetchPublic(methodologyUrl, clock, get);
	// Each page counts only as the right kind of answer, and then only if its body shows the notice:
	// the same body checks step 2 replays on the bodies kept beside the record.
	const reasons: string[] = [];
	const incidentsAnswer = answerProblems(incidents, 'text/html');
	reasons.push(
		...(incidentsAnswer.length > 0
			? incidentsAnswer
			: incidentsProblems(
					release,
					incidents.url,
					incidents.body,
					(day) => day === release.effectiveFrom,
				)),
	);
	const rulesAnswer = answerProblems(rules, 'text/html');
	reasons.push(
		...(rulesAnswer.length > 0 ? rulesAnswer : rulesProblems(release, rules.url, rules.body)),
	);
	const methodologyAnswer = answerProblems(methodology, 'application/json');
	if (methodologyAnswer.length > 0) reasons.push(...methodologyAnswer);
	else {
		const upcoming = upcomingProblems(release, methodology.url, methodology.body);
		if (upcoming.contradicted.length > 0) throw new Mismatch(upcoming.contradicted);
		reasons.push(...upcoming.notShown);
	}
	if (reasons.length > 0) return { kind: 'not_public', reasons };
	const observedAt = clock();
	const names = readbackBodyNames(version);
	const responses = [
		{ ...incidents, name: names.incidents },
		{ ...rules, name: names.rules },
		{ ...methodology, name: names.methodology },
	];
	const noticeAt = noticeAtOf(
		run.startedAt,
		observedAt,
		responses.map((response) => response.dateMs),
	);
	const record = readbackSchema.parse({
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
	});
	// Never write a record step 2 would refuse: it is write-once.
	const problems = readbackRecordProblems(record, release, baseUrl);
	if (problems.length > 0)
		throw new CannotVerify(`the record would not replay: ${problems.join('; ')}`);
	return {
		kind: 'recorded',
		record,
		bodies: responses.map(({ name, body }) => ({ name, bytes: body })),
	};
}

/** N: the latest of the run's start, its observation and the responses' `Date` headers. */
function noticeAtOf(startedAt: Date, observedAt: Date, datesMs: readonly number[]): Date {
	return new Date(Math.max(startedAt.getTime(), observedAt.getTime(), ...datesMs));
}

/**
 * What is wrong with a readback record for `release`, replayed from the record alone (design §2):
 * it names the release; it read `origin`'s three pages in order and kept each body under its name;
 * its clock readings run forward (each request sent, then answered, before the next is sent, and
 * all answered before the observation, which follows the run's start); each `Date` lies inside the
 * run's observation of its request; and its N is the latest of those dates, the run's start and
 * its observation, at or after the release's notice instant. None when it is sound. The bodies
 * and the proof are checked against the files beside it, by the step-2 verifier.
 */
export function readbackRecordProblems(
	record: NoticeReadback,
	release: Methodology,
	origin: string,
): string[] {
	const { version } = release.parameters;
	const problems: string[] = [];
	if (record.methodologyVersion !== version || record.parameterHash !== release.parameterHash) {
		problems.push(
			`the record is for ${shown(record.methodologyVersion)} with parameter hash ${shown(record.parameterHash)}, not ${version} with ${release.parameterHash}`,
		);
	}
	const urls = readbackUrls(origin);
	const names = readbackBodyNames(version);
	const bodies = [names.incidents, names.rules, names.methodology];
	const startedAt = Date.parse(record.run.startedAt);
	const observedAt = Date.parse(record.run.observedAt);
	if (observedAt < startedAt) {
		problems.push(
			`the run observed (${record.run.observedAt}) before it started (${record.run.startedAt})`,
		);
	}
	let previous: { at: number; what: string } | null = null;
	record.responses.forEach((response, index) => {
		const where = `response ${index + 1}`;
		if (response.url !== urls[index])
			problems.push(`${where} is from ${shown(response.url)}, not ${urls[index]}`);
		if (response.body !== bodies[index])
			problems.push(`${where} keeps its body in ${shown(response.body)}, not ${bodies[index]}`);
		const sent = Date.parse(response.requestedAt);
		const received = Date.parse(response.receivedAt);
		if (previous !== null && sent < previous.at)
			problems.push(`${where} was requested (${response.requestedAt}) before ${previous.what}`);
		if (received < sent)
			problems.push(`${where} was received (${response.receivedAt}) before it was requested`);
		if (received > observedAt) {
			problems.push(
				`${where} was received (${response.receivedAt}) after the run's observation (${record.run.observedAt})`,
			);
		}
		previous = {
			at: received,
			what: `response ${index + 1} was received (${response.receivedAt})`,
		};
		if (!dateWithinObservation(Date.parse(response.date), sent, received)) {
			problems.push(
				`${where} states Date ${shown(response.date)}, outside the run's observation of it (${response.requestedAt} to ${response.receivedAt})`,
			);
		}
	});
	const noticeAt = noticeAtOf(
		new Date(record.run.startedAt),
		new Date(record.run.observedAt),
		record.responses.map((response) => Date.parse(response.date)),
	);
	if (record.noticeAt !== noticeAt.toISOString()) {
		problems.push(
			`the record states N ${record.noticeAt}, but its dates, start and observation give ${noticeAt.toISOString()}`,
		);
	}
	if (release.noticePublishedAt === null) {
		problems.push(`${version} has no notice instant, so no readback can be of its notice`);
	} else if (noticeAt.getTime() < Date.parse(release.noticePublishedAt)) {
		problems.push(
			`N ${noticeAt.toISOString()} is before the notice instant ${release.noticePublishedAt}`,
		);
	}
	return problems;
}

/** The three bodies of a readback, by page. */
export type NoticeBodies = { incidents: Uint8Array; rules: Uint8Array; methodology: Uint8Array };

/**
 * What the three bodies a readback of `origin` kept fail to show of `release`'s notice: the same
 * body checks the readback made before writing them, replayed. `accepts` is which effective day
 * the incidents headline may state: the readback requires the registry's own, and step 2 any day
 * up to it, since a postponement (design §7) only ever moves the day later and keeps the record.
 */
export function noticeBodyProblems(
	release: Methodology,
	origin: string,
	bodies: NoticeBodies,
	accepts: (day: string) => boolean,
): string[] {
	const [incidentsUrl, rulesUrl, methodologyUrl] = readbackUrls(origin);
	const upcoming = upcomingProblems(release, methodologyUrl, bodies.methodology);
	return [
		...incidentsProblems(release, incidentsUrl, bodies.incidents, accepts),
		...rulesProblems(release, rulesUrl, bodies.rules),
		...upcoming.contradicted,
		...upcoming.notShown,
	];
}

/** Why an incidents page does not show the dated headline (with an accepted day) and the hash. */
function incidentsProblems(
	release: Methodology,
	url: string,
	body: Uint8Array,
	accepts: (day: string) => boolean,
): string[] {
	const text = visibleTextOf(body);
	const problems: string[] = [];
	const day = announcedDayIn(text, release);
	if (day === null) problems.push(`${url} does not show "${noticeHeadline(release)}"`);
	else if (!accepts(day)) {
		problems.push(
			`${url} does not show "${noticeHeadline(release)}": it states effective ET day ${day}`,
		);
	}
	if (!text.includes(release.parameterHash))
		problems.push(`${url} does not show "${release.parameterHash}"`);
	return problems;
}

/** The effective ET day the first headline for `release`'s notice in `text` states, if any. */
function announcedDayIn(text: string, release: Methodology): string | null {
	const headline = noticeHeadline(release);
	const prefix = headline.slice(0, headline.length - release.effectiveFrom.length);
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`${escaped}(\\d{4}-\\d{2}-\\d{2})`).exec(text)?.[1] ?? null;
}

/** Why a methodology page does not show the release's rules heading. */
function rulesProblems(release: Methodology, url: string, body: Uint8Array): string[] {
	const heading = rulesHeading(release);
	return visibleTextOf(body).includes(heading) ? [] : [`${url} does not show "${heading}"`];
}

/**
 * Why `/api/v1/methodology`'s body does not state the release as upcoming: missing (`notShown`),
 * or stated under another parameter hash (`contradicted`: the notice is wrong, not late).
 */
function upcomingProblems(
	release: Methodology,
	url: string,
	body: Uint8Array,
): { notShown: string[]; contradicted: string[] } {
	const { version } = release.parameters;
	const upcoming = upcomingSchema.safeParse(jsonOf(body));
	const stated = upcoming.success ? upcoming.data.upcoming : null;
	if (stated === null || stated === undefined || stated.version !== version)
		return { notShown: [`${url} has no upcoming block for ${version}`], contradicted: [] };
	if (stated.parameterHash !== release.parameterHash) {
		return {
			notShown: [],
			contradicted: [
				`${url} states ${version} with parameter hash ${shown(stated.parameterHash)}, not ${release.parameterHash}`,
			],
		};
	}
	return { notShown: [], contradicted: [] };
}

/** Why `page` is not a 200 answer of `type`; none if it is. */
function answerProblems(page: Fetched, type: 'text/html' | 'application/json'): string[] {
	if (page.status !== 200) return [`${page.url} answered HTTP ${page.status}`];
	if (page.contentType !== type) {
		return [
			`${page.url} is ${shown(page.contentType)}, not ${type === 'text/html' ? 'an HTML page' : 'JSON'}`,
		];
	}
	return [];
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
	if (!dateWithinObservation(dateMs, sent, received)) {
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

/** Bytes as JSON, or null when they are not JSON. */
export function jsonOf(body: Uint8Array): unknown {
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
