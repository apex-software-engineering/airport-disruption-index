import { describe, expect, it } from 'vitest';

import { feedFixtureText } from '@/test/fixtures';

import { parseFeed } from './feed';

/** The current rule (adapter faa-nas-xml/2): structure is checked. */
const parse = (xml: string) => parseFeed(xml, 'checked');

function parseOk(xml: string) {
	const result = parse(xml);
	if (!result.ok) throw new Error(`expected a parse, got: ${result.detail}`);
	return result.feed;
}

describe('parseFeed on recorded live payloads', () => {
	it.each(['live-2026-11-17T20-43-56Z.xml', 'live-2026-11-17T20-58-29Z.xml'])(
		'%s parses with no events and records ignored lists',
		(name) => {
			const feed = parseOk(feedFixtureText(name));
			expect(feed.events).toEqual([]);
			expect(feed.otherDelayTypes.map((d) => [d.disposition, d.element, d.entries])).toEqual([
				['ignored', 'Airspace_Flow_List', 1],
				['ignored', 'Arrival_Departure_Delay_List', 1],
				['ignored', 'Airport_Closure_List', 1],
				['ignored', 'Airport_Closure_List', 3],
			]);
		},
	);

	it('reads Update_Time as an ISO instant', () => {
		expect(parseOk(feedFixtureText('live-2026-11-17T20-43-56Z.xml')).updateTime).toBe(
			'2026-11-17T20:43:54.000Z',
		);
	});
});

describe('parseFeed on synthetic GS/GDP payloads', () => {
	it('extracts ground stops and ground delay programs with their text fields', () => {
		const feed = parseOk(feedFixtureText('synthetic-gs-gdp.xml'));
		expect(feed.events).toEqual([
			{ program: 'ground_stop', airport: 'LGA', reason: 'airport volume', endTime: '7:45 pm EST' },
			{
				program: 'ground_stop',
				airport: 'BNA',
				reason: 'equipment / outage',
				endTime: '5:30 pm CST.',
			},
			{
				program: 'ground_delay_program',
				airport: 'SFO',
				reason: 'low ceilings',
				average: '1 hour and 38 minutes',
				maximum: '5 hours and 24 minutes',
			},
			{
				program: 'ground_delay_program',
				airport: 'LGA',
				reason: 'wind',
				average: '46 minutes',
				maximum: '2 hours',
			},
		]);
	});

	it('handles repeated names, the Ground_Stop variant, empty lists, nameless and unknown blocks', () => {
		const feed = parseOk(feedFixtureText('synthetic-edge-cases.xml'));
		expect(feed.events.map((e) => `${e.program}:${e.airport}`)).toEqual([
			'ground_stop:ATL',
			'ground_stop:ATL',
			'ground_stop:EWR',
			'ground_delay_program:BOS',
		]);
		expect(feed.events[1]).toEqual({
			program: 'ground_stop',
			airport: 'ATL',
			reason: null,
			endTime: null,
		});
		expect(feed.otherDelayTypes).toEqual([
			{
				disposition: 'ignored',
				name: null,
				element: 'Arrival_Departure_Delay_List',
				entries: 2,
			},
			{ disposition: 'unrecognized', name: 'Deicing', element: 'Deicing_List', entries: 1 },
			{ disposition: 'unrecognized', name: 'Empty block', element: null, entries: 0 },
		]);
	});
});

describe('parseFeed on markup that carries no data', () => {
	it('ignores the XML declaration and processing instructions anywhere', () => {
		expect(parseOk(feedFixtureText('synthetic-processing-instructions.xml')).events).toEqual([
			{ program: 'ground_stop', airport: 'ORD', reason: 'thunderstorms', endTime: '4:15 pm CST' },
		]);
	});

	it.each(['synthetic-gs-block-without-name.xml', 'synthetic-gdp-block-two-names.xml'])(
		'rejects a counted block without exactly one matching Name (%s)',
		(name) => {
			const result = parse(feedFixtureText(name));
			expect(result).toMatchObject({ ok: false, detail: expect.stringMatching(/needs one Name/) });
		},
	);
});

describe('parseFeed on element names that collide with Object.prototype', () => {
	it('records <isPrototypeOf/> as an unrecognized list, not a counted one', () => {
		const xml =
			'<AIRPORT_STATUS_INFORMATION><Update_Time>Tue Nov 17 20:43:54 2026 GMT</Update_Time><Delay_type><Name>Odd</Name><isPrototypeOf/></Delay_type></AIRPORT_STATUS_INFORMATION>';
		expect(parseOk(xml).otherDelayTypes).toEqual([
			{ disposition: 'unrecognized', name: 'Odd', element: 'isPrototypeOf', entries: 0 },
		]);
	});
});

describe('parseFeed failures', () => {
	const wrap = (body: string) =>
		`<AIRPORT_STATUS_INFORMATION><Update_Time>Tue Nov 17 20:43:54 2026 GMT</Update_Time>${body}</AIRPORT_STATUS_INFORMATION>`;

	it('accepts a feed with no Delay_type at all', () => {
		expect(parseOk(wrap('')).events).toEqual([]);
	});

	it.each([
		['an HTML error page', '<html><body>Website Unavailable</body></html>'],
		['truncated XML', wrap('<Delay_type>').slice(0, 80)],
		['a different root', '<OTHER><Update_Time>Tue Nov 17 20:43:54 2026 GMT</Update_Time></OTHER>'],
		['a missing Update_Time', '<AIRPORT_STATUS_INFORMATION></AIRPORT_STATUS_INFORMATION>'],
		[
			'an unparseable Update_Time',
			'<AIRPORT_STATUS_INFORMATION><Update_Time>2026-11-17 20:43</Update_Time></AIRPORT_STATUS_INFORMATION>',
		],
		[
			'a wrong weekday',
			'<AIRPORT_STATUS_INFORMATION><Update_Time>Mon Nov 17 20:43:54 2026 GMT</Update_Time></AIRPORT_STATUS_INFORMATION>',
		],
		[
			'an unknown element inside a GS list',
			wrap(
				'<Delay_type><Ground_Stop_List><Stop><ARPT>ATL</ARPT></Stop></Ground_Stop_List></Delay_type>',
			),
		],
		[
			'a GDP entry without ARPT',
			wrap(
				'<Delay_type><Ground_Delay_List><Ground_Delay><Avg>1 hour</Avg></Ground_Delay></Ground_Delay_List></Delay_type>',
			),
		],
		['two root elements', `${wrap('')}<AIRPORT_STATUS_INFORMATION/>`],
		['a second, different root', `${wrap('')}<Other/>`],
		[
			'a GS list outside a Delay_type block',
			wrap('<Ground_Stop_List><Program><ARPT>ATL</ARPT></Program></Ground_Stop_List>'),
		],
		[
			'a GDP list nested inside another list',
			wrap(
				'<Delay_type><Airport_Closure_List><Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT></Ground_Delay></Ground_Delay_List></Airport_Closure_List></Delay_type>',
			),
		],
		[
			'a GS list in a block named for something else',
			wrap(
				'<Delay_type><Name>Airport Closures</Name><Ground_Stop_List><Program><ARPT>ATL</ARPT></Program></Ground_Stop_List></Delay_type>',
			),
		],
		[
			'a document the XML parser throws on (external entity)',
			'<!DOCTYPE A [<!ENTITY e SYSTEM "file:///etc/passwd">]><AIRPORT_STATUS_INFORMATION><Update_Time>&e;</Update_Time></AIRPORT_STATUS_INFORMATION>',
		],
	])('rejects %s', (_label, xml) => {
		expect(parse(xml).ok).toBe(false);
	});
});

describe('structure checks (adapter faa-nas-xml/2)', () => {
	const UPDATE = '<Update_Time>Tue Nov 17 20:43:54 2026 GMT</Update_Time>';
	const doc = (body: string) => `<AIRPORT_STATUS_INFORMATION>${body}</AIRPORT_STATUS_INFORMATION>`;
	const renamed = doc(
		`${UPDATE}<Delay_Type_V2><Name>Ground Stop Programs</Name><GS_List><Program><ARPT>ATL</ARPT></Program></GS_List></Delay_Type_V2>`,
	);

	it('fails closed on a renamed wrapper that the original rule read as an all-clear', () => {
		const unchecked = parseFeed(renamed, 'unchecked');
		expect(unchecked).toMatchObject({ ok: true, feed: { events: [], otherDelayTypes: [] } });
		expect(parse(renamed)).toEqual({
			ok: false,
			reason: 'unrecognized_structure',
			detail:
				'AIRPORT_STATUS_INFORMATION holds element(s) the feed has never carried: Delay_Type_V2',
		});
	});

	const block = (name: string, inner: string) =>
		doc(`${UPDATE}<Delay_type><Name>${name}</Name>${inner}</Delay_type>`);

	// The last column is what adapter /1 made of it: an all-clear (true) or a parse_error (false).
	it.each([
		[
			'a renamed GS list',
			block('Ground Stop Programs', '<GS_List><Program><ARPT>ATL</ARPT></Program></GS_List>'),
			true,
		],
		[
			'a renamed GDP list',
			block(
				'Ground Delay Programs',
				'<GDP_List><Ground_Delay><ARPT>SFO</ARPT></Ground_Delay></GDP_List>',
			),
			true,
		],
		[
			'an extra list beside the GS list',
			block('Ground Stop Programs', '<Ground_Stop_List/><Other_List/>'),
			true,
		],
		['a counted name with no list', block('Ground Delay Programs', ''), true],
		["the other program's list", block('Ground Stop Programs', '<Ground_Delay_List/>'), false],
	])('fails closed on a counted-program block holding %s', (_label, xml, validUnderV1) => {
		expect(parseFeed(xml, 'unchecked').ok).toBe(validUnderV1);
		expect(parse(xml)).toMatchObject({
			ok: false,
			reason: 'unrecognized_structure',
			detail: expect.stringMatching(/block must hold exactly (Ground_Stop_List|Ground_Delay_List)/),
		});
	});

	it('still records an unknown block with an unknown list as unrecognized, not invalid', () => {
		const xml = block(
			'Deicing',
			'<Deicing_List><Airport><ARPT>ORD</ARPT></Airport></Deicing_List>',
		);
		expect(parse(xml)).toMatchObject({
			ok: true,
			feed: {
				otherDelayTypes: [
					{ disposition: 'unrecognized', name: 'Deicing', element: 'Deicing_List', entries: 1 },
				],
			},
		});
	});

	it('keeps a calm payload with no Delay_type valid', () => {
		const calm = doc(`${UPDATE}<Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>`);
		expect(parse(calm)).toMatchObject({ ok: true, feed: { events: [], otherDelayTypes: [] } });
		expect(parse(doc(UPDATE))).toMatchObject({ ok: true });
	});

	it.each([
		'live-2026-11-17T20-43-56Z.xml',
		'live-2026-11-17T20-58-29Z.xml',
		'live-2026-11-20T01-03-33Z.xml',
		'synthetic-edge-cases.xml',
		'synthetic-gdp-block-two-names.xml',
		'synthetic-gs-block-without-name.xml',
		'synthetic-gs-gdp.xml',
		'synthetic-processing-instructions.xml',
	])('reads %s exactly as the original rule does', (name) => {
		const xml = feedFixtureText(name);
		expect(parse(xml)).toEqual(parseFeed(xml, 'unchecked'));
	});
});
