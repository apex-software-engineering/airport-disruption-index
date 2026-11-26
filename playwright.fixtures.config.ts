import { defineConfig, devices } from '@playwright/test';

import path from 'node:path';

import { FIXTURE_NOW, SCENARIOS } from './tests/fixtures/scenarios';

const FIXTURE_CLOCK = path.resolve(__dirname, 'tests/fixtures/fixture-clock.mjs');

/**
 * The home chart against fixture data: one production server (`next start`, so run
 * `npm run build` first) per scenario, each reading its own filesystem store. Unlike the smoke
 * suite this needs no deployment and pins the data and the servers' clock (FIXTURE_NOW), so it can
 * check the cases production data cannot be relied on to show (only suspended days, more history
 * than one request returns).
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
		env: {
			ADI_DATA_DIR: scenario.dir,
			ADI_FIXTURE_NOW: FIXTURE_NOW,
			NODE_OPTIONS: `--import ${FIXTURE_CLOCK}`,
		},
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
