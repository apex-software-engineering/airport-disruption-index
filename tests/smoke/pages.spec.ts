import path from 'node:path';

import { expect, test } from '@playwright/test';

import { site } from '@/lib/site';

const PAGES = [
	{ path: '/', name: 'home', heading: site.name },
	{ path: '/methodology', name: 'methodology', heading: /methodology v\d+\.\d+\.\d+/ },
	{ path: '/docs/api', name: 'api', heading: 'API' },
	{ path: '/sources', name: 'sources', heading: 'Sources' },
	{ path: '/status', name: 'status', heading: 'Status' },
] as const;

/** Set to a directory to keep a full-page screenshot of every page (for PR evidence). */
const screenshotDir = process.env.SMOKE_SCREENSHOT_DIR;

for (const page of PAGES) {
	test(`${page.path} renders with the index footer`, async ({ page: browser }) => {
		const response = await browser.goto(page.path);
		expect(response?.status(), `${page.path} status`).toBe(200);
		await expect(browser.getByRole('heading', { level: 1 })).toHaveText(page.heading);
		await expect(browser.locator('footer')).toContainText(site.footer);
		await expect(browser.locator('footer').getByRole('link')).toHaveAttribute('href', site.repoUrl);
		if (screenshotDir) {
			await browser.screenshot({
				path: path.join(screenshotDir, `${page.name}.png`),
				fullPage: true,
			});
		}
	});
}

test('/ shows the running value with its chart, or says plainly there is none', async ({
	page,
}) => {
	await page.goto('/');
	const runningValue = page.getByRole('group', { name: 'ADI, running' });
	const emptyState = page.getByText(/No valid round has been recorded for \d{4}-\d{2}-\d{2} yet/);
	await expect(runningValue.or(emptyState)).toBeVisible();
	if (await runningValue.isVisible()) {
		// A whole number of airport-minutes, zero included, e.g. "0" or "1,234".
		await expect(runningValue.getByText(/^\d{1,3}(,\d{3})*$/)).toBeVisible();
		await expect(page.getByRole('img', { name: /Airport-minutes per UTC hour/ })).toBeVisible();
	}
});
