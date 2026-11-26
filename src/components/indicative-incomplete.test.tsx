import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IndicativeIncomplete } from './indicative-incomplete';

describe('the indicative series when stored days cannot be read (Sol #38 r1, finding 3)', () => {
	it('says how many days are missing and where they are named', () => {
		const html = renderToStaticMarkup(
			<IndicativeIncomplete
				misfiled={{ problem: 'misfiled_indicative', objects: ['indicative/2.0.0/2026-11-21.json'] }}
			/>,
		);
		expect(html.replace(/<[^>]*>/g, '')).toContain(
			'One stored indicative day could not be read and is not shown.',
		);
		expect(html).toContain('href="/api/v1/indicative/history"');
	});

	it('says nothing when every stored day was read', () => {
		expect(renderToStaticMarkup(<IndicativeIncomplete misfiled={undefined} />)).toBe('');
	});
});
