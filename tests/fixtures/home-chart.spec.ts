import { expect, test, type Page } from '@playwright/test';

import { addDays } from '@/lib/index/time';

import {
	LONG_HISTORY,
	LONG_HISTORY_DAYS,
	longHistoryPrints,
	MISSING_DAYS_AGO,
	SUSPENDED_ONLY,
	yesterday,
} from './scenarios';

/** e.g. "(Nov 20, 7:00 PM – Nov 21, 7:00 PM EST)", a UTC day in New York time. */
const LOCAL_DAY =
	/^\([A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M – [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M E[SD]T\)$/;

const chartOf = (page: Page) => page.getByRole('region', { name: 'Daily ADI chart' });

/**
 * The home page with its chart ready: the plot stays hidden (so unfocusable) until it is measured
 * after hydration, so every interaction waits for it to show.
 */
async function openHome(page: Page) {
	await page.goto('/');
	await expect(chartOf(page).locator('svg[aria-describedby]')).toBeVisible();
	return chartOf(page);
}
const plotted = (page: Page) => chartOf(page).locator('[data-chart-point]');
const sources = (page: Page) => chartOf(page).locator('figcaption a');

/** The prints a range ending yesterday shows, from the fixture itself. */
function printsSince(daysBack: number | null): number {
	if (daysBack === null) return longHistoryPrints().length;
	const from = addDays(yesterday(), 1 - daysBack);
	return longHistoryPrints().filter((day) => day.date >= from).length;
}

test.describe('only suspended days', () => {
	test.use({ baseURL: SUSPENDED_ONLY.baseURL });

	test('keeps the prints, the table and the sources, with an honest no-value headline', async ({
		page,
		request,
	}) => {
		const chart = await openHome(page);
		await expect(chart.getByRole('group', { name: 'ADI, no value' })).toContainText('No value yet');
		await expect(chart.locator('[data-suspended-band]')).toHaveCount(1);
		await expect(chart.locator('[data-suspended-band]')).toHaveAttribute(
			'data-suspended-band',
			'2',
		);
		await expect(plotted(page)).toHaveCount(2);
		await expect(chart.getByRole('table').locator('tbody tr')).toHaveCount(2);

		const href = await sources(page).first().getAttribute('href');
		expect(href).toBe(`/api/v1/history?from=${addDays(yesterday(), -1)}&to=${yesterday()}`);
		const body: unknown = await (await request.get(`${SUSPENDED_ONLY.baseURL}${href}`)).json();
		expect(body).toMatchObject({ days: [{ status: 'suspended' }, { status: 'suspended' }] });

		await plotted(page).last().focus();
		const tooltip = chart.locator('[data-chart-tooltip]');
		await expect(tooltip).toContainText('Suspended');
		await expect(tooltip.locator('[data-local-time]').first()).toHaveText(LOCAL_DAY);
	});
});

test.describe('a long history', () => {
	test.use({ baseURL: LONG_HISTORY.baseURL });

	test('each range plots its own prints, and All chains requests to cover them all', async ({
		page,
	}) => {
		const chart = await openHome(page);
		const button = (name: string) =>
			chart.getByRole('group', { name: 'Chart range' }).getByRole('button', { name });

		await expect(button('1M')).toHaveAttribute('aria-pressed', 'true');
		await expect(plotted(page)).toHaveCount(printsSince(30));

		await button('1W').click();
		await expect(button('1W')).toHaveAttribute('aria-pressed', 'true');
		await expect(plotted(page)).toHaveCount(printsSince(7));
		await expect(sources(page)).toHaveCount(1);
		await expect(sources(page)).toHaveAttribute(
			'href',
			`/api/v1/history?from=${addDays(yesterday(), -6)}&to=${yesterday()}`,
		);

		await button('All').click();
		await expect(plotted(page)).toHaveCount(printsSince(null));
		expect(printsSince(null)).toBe(LONG_HISTORY_DAYS - MISSING_DAYS_AGO.length);
		await expect(sources(page)).toHaveCount(2);
		// The suspended run of three is one band; the single suspended day is another.
		await expect(chart.locator('[data-suspended-band]')).toHaveCount(2);
		await expect(chart.locator('[data-suspended-band="3"]')).toHaveCount(1);
	});

	test('a missing day stays blank beside a band, even at phone width', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 800 });
		const chart = await openHome(page);
		await chart.getByRole('button', { name: 'All' }).click();
		// About 0.7px per day across 400 days: a band is its days wide, never a fixed minimum.
		const widths = await chart
			.locator('[data-suspended-band] rect')
			.evaluateAll((rects) => rects.map((rect) => Number(rect.getAttribute('width'))));
		expect(widths).toHaveLength(2);
		for (const width of widths) expect(width).toBeLessThan(3);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
		).toBeLessThanOrEqual(0);
	});

	test('keyboard focus survives the pointer and Escape, and the tooltip describes it', async ({
		page,
	}) => {
		const chart = await openHome(page);
		const newest = plotted(page).last();
		await newest.focus();
		await page.keyboard.press('ArrowLeft');
		const focused = chart.locator('[data-chart-point]:focus');
		await expect(focused).toHaveCount(1);
		const tooltipId = await chart.locator('[data-chart-tooltip]').getAttribute('id');
		await expect(focused).toHaveAttribute('aria-describedby', tooltipId ?? 'missing');
		await expect(chart.locator(`[id="${tooltipId}"] [data-local-time]`).first()).toHaveText(
			LOCAL_DAY,
		);

		// The pointer passing over and leaving never takes the focus away.
		const box = await chart.locator('svg').first().boundingBox();
		if (box === null) throw new Error('the chart has no box');
		await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
		await page.mouse.move(0, 0);
		await expect(focused).toHaveCount(1);
		await expect(chart.locator('[data-chart-tooltip]')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(chart.locator('[data-chart-tooltip]')).toHaveCount(0);
		await expect(focused).toHaveCount(1);
		// The focused point stays the tab stop, so Tab and Shift+Tab leave and return to it.
		await expect(focused).toHaveAttribute('tabindex', '0');
		await expect(chart.locator('[data-chart-point][tabindex="0"]')).toHaveCount(1);
	});
});
