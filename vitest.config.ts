import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	// tests/smoke and tests/fixtures are Playwright suites (a deployment, fixture servers), not unit tests.
	test: {
		exclude: [...configDefaults.exclude, 'tests/smoke/**', 'tests/fixtures/**'],
		// next.config.ts inlines this at build time; tests run unbuilt.
		env: { DEPLOYED_COMMIT: 'unknown' },
	},
});
