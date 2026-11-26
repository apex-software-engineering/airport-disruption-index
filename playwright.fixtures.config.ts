import { defineConfig, devices } from '@playwright/test';

import { SCENARIOS } from './tests/fixtures/scenarios';

/**
 * The home chart against fixture data: one production server (`next start`, so run
 * `npm run build` first) per scenario, each reading its own filesystem store. Unlike the smoke
 * suite this needs no deployment and pins the data, so it can check the cases production data
 * cannot be relied on to show (only suspended days, more history than one request returns).
 */
export default defineConfig({
	testDir: './tests/fixtures',
	outputDir: './test-results/fixtures',
	globalSetup: './tests/fixtures/scenarios.ts',
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: { trace: 'off', screenshot: 'only-on-failure' },
	webServer: SCENARIOS.map((scenario) => ({
		command: `npx next start -p ${scenario.port}`,
		url: `${scenario.baseURL}/api/v1/methodology`,
		env: { ADI_DATA_DIR: scenario.dir },
		reuseExistingServer: false,
		timeout: 60_000,
	})),
	projects: [
		{
			name: 'chrome',
			use: {
				...devices['Desktop Chrome'],
				channel: 'chrome',
				launchOptions: { chromiumSandbox: true },
				viewport: { width: 1280, height: 900 },
				timezoneId: 'America/New_York',
			},
		},
	],
});
