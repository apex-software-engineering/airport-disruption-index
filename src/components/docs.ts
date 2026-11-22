/**
 * The repo's docs/*.md files are the single source of truth for the methodology, sources,
 * incident-log and legal prose; the site renders them as they are. Cross-links between docs become site
 * routes, and headings get GitHub-style ids so `methodology.md#source` lands on the same section.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Marked, type Tokens } from 'marked';

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

export async function renderDoc(name: DocName): Promise<string> {
	return marked.parse(await readDoc(name), { async: true });
}
