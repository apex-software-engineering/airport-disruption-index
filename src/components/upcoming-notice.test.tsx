import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { UpcomingNotice } from './upcoming-notice';

const text = (now: string) =>
	renderToStaticMarkup(<UpcomingNotice now={new Date(now)} />)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ');

describe('the notice-period banner', () => {
	it('names the release, its instant, its zone and where its notice and rules are', () => {
		const markup = renderToStaticMarkup(<UpcomingNotice now={new Date('2026-11-29T00:00:00Z')} />);
		expect(markup).toContain('href="/incidents"');
		expect(markup).toContain('href="/methodology#settlement-rules"');
		expect(markup).toContain('dateTime="2027-01-01T00:00:00.000Z"');
		expect(text('2026-11-29T00:00:00Z')).toContain(
			'from 2027-01-01 each settlement day is the America/New_York (US Eastern) day. Days up to 2026-12-31 stay under v1.0.0',
		);
	});

	it('shows nothing before the notice instant or outside a notice period', () => {
		expect(
			renderToStaticMarkup(<UpcomingNotice now={new Date('2026-11-28T23:59:59.999Z')} />),
		).toBe('');
		expect(renderToStaticMarkup(<UpcomingNotice now={new Date('2027-01-01T00:00:00Z')} />)).toBe(
			'',
		);
	});
});
