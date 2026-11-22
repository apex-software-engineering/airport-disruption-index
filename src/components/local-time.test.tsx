import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { docToReact } from './doc-body';
import { LocalHour, LocalTime, LocalTimeTitle } from './local-time';

// renderToStaticMarkup renders the server snapshot, which is also what hydration renders.
describe('local time on the server', () => {
	it('reserves the slot with the UTC text, hidden, and leaves the local time empty', () => {
		const html = renderToStaticMarkup(<LocalTime at='2026-11-22T00:30:00.000Z' />);
		expect(html).toContain('class="invisible [grid-area:1/1]">(Nov 22, 12:30 AM UTC)</span>');
		expect(html).toMatch(/<span data-local-time="true" aria-hidden="false"[^>]*><\/span>/);
		expect(html).toContain('noscript:hidden');
	});

	it('renders the whole tooltip text in UTC, as one string', () => {
		const html = renderToStaticMarkup(
			<svg>
				<LocalTimeTitle
					at='2026-11-22T00:00:00.000Z'
					before='00:00 UTC'
					after={'\nnot yet ended'}
				/>
			</svg>,
		);
		expect(html).toBe('<svg><title>00:00 UTC\nnot yet ended</title></svg>');
	});

	it('leaves the axis line empty', () => {
		expect(renderToStaticMarkup(<LocalHour at='2026-11-22T00:00:00.000Z' />)).toBe('');
	});
});

describe('docToReact', () => {
	it('gives a docs <time> the local time beside it', () => {
		const html = renderToStaticMarkup(
			docToReact('<p>started <time datetime="2026-11-20T04:30:00Z">04:30Z</time>.</p>'),
		);
		expect(html).toContain('<p>started <time dateTime="2026-11-20T04:30:00Z">04:30Z</time>');
		expect(html).toContain('data-local-time');
	});

	it('refuses a <time> without an instant or with markup inside', () => {
		expect(() => docToReact('<time>04:30Z</time>')).toThrow('datetime instant');
		expect(() => docToReact('<time datetime="2026-11-20T04:30:00Z"><b>x</b></time>')).toThrow();
		expect(() => renderToStaticMarkup(docToReact('<time datetime="soon">x</time>'))).toThrow(
			'not an instant',
		);
	});
});
