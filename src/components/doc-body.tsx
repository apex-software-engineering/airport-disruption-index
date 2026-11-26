import parse, { Element, Text } from 'html-react-parser';
import type { ReactNode } from 'react';

import { parseUtcDate } from '@/lib/index/time';

import { renderDoc, type DocName } from './docs';
import { LocalTime } from './local-time';

/** An ISO instant with its offset stated (`Z` or `±hh:mm`), so it means the same everywhere. */
const ISO_INSTANT =
	/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isIsoInstant(text: string): boolean {
	const date = ISO_INSTANT.exec(text)?.[1];
	return date !== undefined && parseUtcDate(date) !== null;
}

/**
 * Rendered doc HTML as React. The one tag given behaviour is `<time datetime="ISO">`, which gets
 * the viewer's local time beside it like every other UTC time on the site.
 */
export function docToReact(html: string): ReactNode {
	return parse(html, {
		replace(node) {
			if (!(node instanceof Element) || node.name !== 'time') return undefined;
			const at = node.attribs.datetime;
			const [label, ...rest] = node.children;
			if (at === undefined || !(label instanceof Text) || rest.length > 0) {
				throw new Error('a <time> in docs needs a datetime instant and plain text');
			}
			if (!isIsoInstant(at)) {
				throw new Error(`docs <time datetime="${at}"> is not an ISO instant with Z or an offset`);
			}
			// Punctuation right after the time stays with it on the UTC line, above the local one.
			const next = node.next;
			const punctuation = next instanceof Text ? (/^[.,;:!?)]+/.exec(next.data)?.[0] ?? '') : '';
			if (next instanceof Text) next.data = next.data.slice(punctuation.length);
			return (
				<>
					<time dateTime={at}>{label.data}</time>
					{punctuation}
					<LocalTime at={at} />
				</>
			);
		},
	});
}

/** A docs/*.md file rendered as the page body, as of now. The markdown is ours, from the repo. */
export async function DocBody({ name }: { name: DocName }) {
	return <article className='prose-doc'>{docToReact(await renderDoc(name, new Date()))}</article>;
}
