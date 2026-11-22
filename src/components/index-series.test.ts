import { describe, expect, it } from 'vitest';

import { addDays } from '@/lib/index/time';

import {
	chartModel,
	chartPoints,
	headlineOf,
	linesOf,
	type SeriesPrint,
	type SeriesToday,
} from './index-series';

const ENDPOINTS = { history: '/api/v1/history', current: '/api/v1/current' };

function print(date: string, status: SeriesPrint['status'], value: number | null): SeriesPrint {
	return {
		date,
		status,
		value,
		groundStopValue: value === null ? null : Math.floor(value / 10),
		coveragePercent: status === 'final' ? 100 : status === 'degraded' ? 81.25 : 40,
	};
}

const today = (date: string, value = 740): SeriesToday => ({
	date,
	value,
	groundStopValue: 285,
	coveragePercent: 78.13,
	asOf: `${date}T18:45:08.856Z`,
});

/** `count` consecutive final prints ending on `last`. */
function finals(last: string, count: number): SeriesPrint[] {
	return Array.from({ length: count }, (_, index) =>
		print(addDays(last, index + 1 - count), 'final', 100 + index),
	);
}

describe('chartPoints', () => {
	it('keeps the prints as served and appends today as provisional', () => {
		const points = chartPoints(
			[print('2026-11-20', 'degraded', 135), print('2026-11-21', 'final', 1135)],
			today('2026-11-22'),
		);
		expect(points.map((point) => [point.date, point.status])).toEqual([
			['2026-11-20', 'degraded'],
			['2026-11-21', 'final'],
			['2026-11-22', 'provisional'],
		]);
		expect(points[1]?.day).toBe((points[0]?.day ?? 0) + 1);
	});

	it('refuses prints out of order, a valued suspended day and a final day without a value', () => {
		expect(() =>
			chartPoints([print('2026-11-21', 'final', 1), print('2026-11-20', 'final', 2)], null),
		).toThrow('out of order');
		expect(() => chartPoints([print('2026-11-21', 'suspended', 5)], null)).toThrow(
			'suspended but carries a value',
		);
		expect(() => chartPoints([print('2026-11-21', 'final', null)], null)).toThrow('has no value');
	});

	it('refuses a running value for a day that already has a print', () => {
		expect(() => chartPoints([print('2026-11-21', 'final', 1)], today('2026-11-21'))).toThrow(
			'already has a print',
		);
	});
});

describe('linesOf', () => {
	it('breaks the line at a suspended day and at a day with no print, never bridging them', () => {
		const points = chartPoints(
			[
				print('2026-11-01', 'final', 10),
				print('2026-11-02', 'degraded', 20),
				print('2026-11-03', 'suspended', null),
				print('2026-11-04', 'final', 30),
				// 2026-11-05 has no print.
				print('2026-11-06', 'final', 40),
				print('2026-11-07', 'final', 50),
			],
			null,
		);
		const { runs, provisionalLink } = linesOf(points);
		expect(runs.map((run) => run.map((point) => point.date))).toEqual([
			['2026-11-01', '2026-11-02'],
			['2026-11-04'],
			['2026-11-06', '2026-11-07'],
		]);
		expect(provisionalLink).toBeNull();
	});

	it('links today to yesterday only when yesterday has a value', () => {
		const linked = linesOf(chartPoints([print('2026-11-21', 'final', 1)], today('2026-11-22')));
		expect(linked.provisionalLink?.map((point) => point.status)).toEqual(['final', 'provisional']);
		expect(linked.runs).toHaveLength(1);

		for (const prints of [
			[print('2026-11-21', 'suspended', null)],
			[print('2026-11-20', 'final', 1)],
			[],
		]) {
			expect(linesOf(chartPoints(prints, today('2026-11-22'))).provisionalLink).toBeNull();
		}
	});
});

describe('headlineOf', () => {
	it('compares the running value with the last final print, skipping a degraded one', () => {
		const headline = headlineOf(
			chartPoints(
				[print('2026-11-20', 'final', 900), print('2026-11-21', 'degraded', 135)],
				today('2026-11-22'),
			),
		);
		expect(headline?.latest.status).toBe('provisional');
		expect(headline?.previousFinal).toEqual({ date: '2026-11-20', value: 900 });
		expect(headline?.finalCount).toBe(1);
	});

	it('has no comparison when no final print precedes the latest value', () => {
		const headline = headlineOf(chartPoints([print('2026-11-21', 'final', 5)], null));
		expect(headline?.latest.date).toBe('2026-11-21');
		expect(headline?.previousFinal).toBeNull();
	});

	it('takes the latest day that has a value when the newest print is suspended', () => {
		const headline = headlineOf(
			chartPoints([print('2026-11-20', 'final', 5), print('2026-11-21', 'suspended', null)], null),
		);
		expect(headline?.latest.date).toBe('2026-11-20');
		expect(headlineOf(chartPoints([print('2026-11-21', 'suspended', null)], null))).toBeNull();
	});
});

describe('chartModel', () => {
	it('is null with nothing to chart', () => {
		expect(chartModel([], '2026-11-21', ENDPOINTS)).toBeNull();
	});

	it('offers only All while every range would show the same prints', () => {
		const points = chartPoints(
			[print('2026-11-20', 'degraded', 135), print('2026-11-21', 'final', 1135)],
			today('2026-11-22'),
		);
		const model = chartModel(points, '2026-11-21', ENDPOINTS);
		expect(model?.initial).toBe('all');
		expect(model?.ranges.map((range) => [range.id, range.disabledReason])).toEqual([
			['1W', '1W shows the same 3 prints as 1M'],
			['1M', '1M shows the same 3 prints as All'],
			['all', null],
		]);
		const all = model?.ranges.find((range) => range.id === 'all');
		expect(all?.sources).toEqual([
			'/api/v1/history?from=2026-11-20&to=2026-11-21',
			'/api/v1/current',
		]);
		expect(all?.summary).toBe(
			'Daily ADI, 3 days from 2026-11-20 to 2026-11-22 (UTC): 1 final, 1 degraded, 0 suspended, and today so far (provisional). Latest: 740 airport-minutes on 2026-11-22, today so far, provisional.',
		);
	});

	it('cuts calendar ranges ending on the newest point, defaulting to 1M once it differs', () => {
		const points = chartPoints(finals('2026-11-21', 45), null);
		const model = chartModel(points, '2026-11-21', ENDPOINTS);
		expect(model?.initial).toBe('1M');
		const byId = Object.fromEntries((model?.ranges ?? []).map((range) => [range.id, range]));
		expect(byId['1W']?.points).toHaveLength(7);
		expect(byId['1W']?.disabledReason).toBeNull();
		expect(byId['1W']?.sources).toEqual(['/api/v1/history?from=2026-11-15&to=2026-11-21']);
		expect(byId['1M']?.points).toHaveLength(30);
		expect(byId['1M']?.lastDay).toBe((byId['1M']?.firstDay ?? 0) + 29);
		expect(byId.all?.points).toHaveLength(45);
	});

	it('spans calendar days, so a missing day stays a gap on the axis rather than being closed up', () => {
		const prints = finals('2026-11-21', 20).filter((day) => day.date !== '2026-11-18');
		const week = chartModel(chartPoints(prints, null), '2026-11-21', ENDPOINTS)?.ranges[0];
		expect(week?.lastDay).toBe((week?.firstDay ?? 0) + 6);
		expect(week?.points).toHaveLength(6);
		expect(week?.lines.runs.map((run) => run.length)).toEqual([3, 3]);
	});
});
