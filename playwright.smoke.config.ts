import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke checks against a deployed site. BASE_URL is required (production is
 * https://airports.apexsofteng.com); no local server is started. A Vercel preview behind
 * deployment protection also needs VERCEL_AUTOMATION_BYPASS_SECRET.
 */
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('Set BASE_URL to the deployment to check');

const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
	testDir: './tests/smoke',
	outputDir: './test-results/smoke',
	forbidOnly: !!process.env.CI,
	// A monitor should page on an outage, not on one dropped request.
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI
		? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report/smoke' }], ['list']]
		: [['list']],
	use: {
		baseURL,
		// Pages make no third-party requests, so the bypass header only reaches the deployment.
		extraHTTPHeaders: bypass ? { 'x-vercel-protection-bypass': bypass } : {},
		// No traces: they would record the bypass header in an uploaded report.
		trace: 'off',
		screenshot: 'only-on-failure',
	},
	projects: [
		{
			name: 'chrome',
			use: {
				...devices['Desktop Chrome'],
				channel: 'chrome',
				launchOptions: { chromiumSandbox: true },
				viewport: { width: 1280, height: 900 },
			},
		},
	],
});
