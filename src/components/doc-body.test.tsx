import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DocBody } from './doc-body';

describe('a doc rendered at its page’s one instant (Sol #39 r1, finding 3)', () => {
	it('shows a notice’s passages by the instant it is given, never by the clock', async () => {
		const at = async (instant: string) =>
			renderToStaticMarkup(await DocBody({ name: 'incidents', now: new Date(instant) }));
		expect(await at('2026-11-28T23:59:59.999Z')).not.toContain('v2.0.0');
		expect(await at('2026-11-29T00:00:00.000Z')).toContain('v2.0.0');
	});
});
