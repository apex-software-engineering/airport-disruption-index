import { describe, expect, it } from 'vitest';

import { feedFixtureText } from '@/test/fixtures';

import { parseFeed } from './feed';

function parseOk(xml: string) {
	const result = parseFeed(xml);
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
				name: 'General Arrival/Departure Delay Info',
				element: 'Arrival_Departure_Delay_List',
				entries: 2,
			},
			{ disposition: 'unrecognized', name: 'Deicing', element: 'Deicing_List', entries: 1 },
			{ disposition: 'unrecognized', name: 'Empty block', element: null, entries: 0 },
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
	])('rejects %s', (_label, xml) => {
		expect(parseFeed(xml).ok).toBe(false);
	});
});
