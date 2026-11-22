import parse, { Element, Text } from 'html-react-parser';
import type { ReactNode } from 'react';

import { renderDoc, type DocName } from './docs';
import { LocalTime } from './local-time';

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
			return (
				<>
					<time dateTime={at}>{label.data}</time>
					<LocalTime at={at} />
				</>
			);
		},
	});
}

/** A docs/*.md file rendered as the page body. The markdown is ours, from the repo. */
export async function DocBody({ name }: { name: DocName }) {
	return <article className='prose-doc'>{docToReact(await renderDoc(name))}</article>;
}
