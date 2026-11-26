/**
 * The repo's docs/*.md files are the single source of truth for the methodology, sources,
 * incident-log and legal prose; the site renders them as they are. Cross-links between docs become site
 * routes, and headings get GitHub-style ids so `methodology.md#source` lands on the same section.
 * A methodology notice's passages are gated to its instant (`gateNotices`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Marked, type Tokens } from 'marked';

import { isNoticePublished, type Methodology } from '@/lib/index/methodology';
import { RELEASES } from '@/lib/index/releases';

/** Each rendered doc and the route that renders it. */
export const DOC_ROUTES = {
	methodology: '/methodology',
	sources: '/sources',
	incidents: '/incidents',
	terms: '/terms',
	disclaimer: '/disclaimer',
	independence: '/independence',
} as const;
export type DocName = keyof typeof DOC_ROUTES;

const DOCS_DIR = path.join(process.cwd(), 'docs');

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function headingId(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

function isDocName(name: string): name is DocName {
	return Object.hasOwn(DOC_ROUTES, name);
}

export const DOC_NAMES: readonly DocName[] = Object.keys(DOC_ROUTES).filter(isDocName);

/** Absolute and in-page links pass through; a link to another doc becomes its route. */
export function siteHref(href: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/'))
		return href;
	const [file = '', hash] = href.split('#');
	const name = file.replace(/^\.\//, '').replace(/\.md$/, '');
	if (!file.endsWith('.md') || !isDocName(name)) {
		throw new Error(`docs link ${href} has no page on the site; link a URL or another doc`);
	}
	return hash === undefined ? DOC_ROUTES[name] : `${DOC_ROUTES[name]}#${hash}`;
}

const escapeAttribute = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const marked = new Marked({
	gfm: true,
	renderer: {
		heading({ tokens, depth, text }: Tokens.Heading) {
			return `<h${depth} id="${escapeAttribute(headingId(text))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
		},
		link({ href, title, tokens }: Tokens.Link) {
			const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
			return `<a href="${escapeAttribute(siteHref(href))}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`;
		},
	},
});

export async function readDoc(name: DocName): Promise<string> {
	return readFile(path.join(DOCS_DIR, `${name}.md`), 'utf8');
}

/**
 * A notice's passages, marked in the markdown with HTML comments (invisible on GitHub), appear on
 * the site together at the release's `noticePublishedAt`, with everything else the notice gates:
 * - `<!-- notice 2.0.0 -->…<!-- /notice -->` from that instant, while the release stands;
 * - `<!-- before-notice 2.0.0 -->…<!-- /before-notice -->` otherwise: until the instant, and again
 *   once the release is withdrawn, so withdrawn rules are never shown as upcoming;
 * - `<!-- log 2.0.0 -->…<!-- /log -->` from that instant for good: the incident log never drops
 *   an entry, a withdrawn release's announcement included.
 * Malformed markers are an error, never silently shown or hidden (`checkNoticeMarkers`).
 */
export function gateNotices(markdown: string, now: Date): string {
	return gateNoticesIn(markdown, now, RELEASES);
}

/** `gateNotices` over a given registry. */
export function gateNoticesIn(
	markdown: string,
	now: Date,
	releases: readonly Methodology[],
): string {
	checkNoticeMarkers(markdown, releases);
	return markdown.replace(
		/<!-- (notice|before-notice|log) (\S+) -->\n([\s\S]*?)<!-- \/\1 -->\n?/g,
		(_, kind: string, version: string, passage: string) => {
			const release = releases.find((candidate) => candidate.parameters.version === version);
			if (release === undefined) throw new Error(`docs mark a notice of ${version}, no release`);
			const published = isNoticePublished(release, now);
			const standing = published && !release.withdrawn;
			const shown = kind === 'log' ? published : kind === 'notice' ? standing : !standing;
			return shown ? passage : '';
		},
	);
}

/**
 * Every notice marker, checked as a structure before anything is hidden: each opener names a
 * registered release and is closed, by the matching closer, before the next opener. Nesting, a
 * stray or mismatched closer, or an opener left open throws, so no malformed marker can ever show
 * a passage early.
 */
function checkNoticeMarkers(markdown: string, releases: readonly Methodology[]): void {
	let open: { kind: string; version: string } | null = null;
	for (const [marker, closing, kind, version] of markdown.matchAll(
		/<!--\s*(\/?)(notice|before-notice|log)\b(?:\s+(\S+))?\s*-->/g,
	)) {
		if (closing === '/') {
			if (open === null || open.kind !== kind || version !== undefined)
				throw new Error(`docs close ${JSON.stringify(marker)} with no matching open marker`);
			open = null;
		} else {
			if (open !== null)
				throw new Error(`docs open ${JSON.stringify(marker)} inside ${open.kind} ${open.version}`);
			if (version === undefined || kind === undefined)
				throw new Error(`docs open ${JSON.stringify(marker)} without a version`);
			if (!releases.some((release) => release.parameters.version === version))
				throw new Error(`docs mark a notice of ${version}, no release`);
			open = { kind, version };
		}
	}
	if (open !== null) throw new Error(`docs leave ${open.kind} ${open.version} unclosed`);
}

/** A doc as the site renders it at `now`. */
export async function renderDoc(name: DocName, now: Date): Promise<string> {
	return marked.parse(gateNotices(await readDoc(name), now), { async: true });
}
