import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { docToReact } from './doc-body';
import { DOC_NAMES, renderDoc } from './docs';
import { LocalHour, LocalTime, LocalTimeTitle } from './local-time';

// renderToStaticMarkup renders the server snapshot, which is also what hydration renders.
describe('local time on the server', () => {
	it('reserves the widest local form, hidden, and leaves the local time empty', () => {
		const html = renderToStaticMarkup(<LocalTime at='2026-11-22T00:30:00.000Z' />);
		expect(html).toContain('class="invisible [grid-area:1/1]">(May 10, 12:15 PM GMT+10:30)</span>');
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
	});

	it.each(['soon', '2026-11-20', '2026-11-20T04:30:00', '2026-11-20 04:30Z', '2026-02-30T04:30Z'])(
		'refuses datetime "%s": an ISO instant needs Z or an offset',
		(datetime) => {
			expect(() => docToReact(`<time datetime="${datetime}">x</time>`)).toThrow(
				'not an ISO instant',
			);
		},
	);

	// The incidents page renders per request, so a bad <time> in a doc must fail CI instead.
	it.each(DOC_NAMES)('renders every <time> in docs/%s.md', async (name) => {
		const html = await renderDoc(name);
		expect(() => renderToStaticMarkup(docToReact(html))).not.toThrow();
	});

	it('accepts Z and an explicit offset', () => {
		for (const datetime of ['2026-11-20T04:30Z', '2026-11-19T23:30:00.000-05:00']) {
			expect(() => docToReact(`<time datetime="${datetime}">x</time>`)).not.toThrow();
		}
	});
});
