import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
	},
	// tests/smoke is the Playwright suite against a deployment, not unit tests.
	test: { exclude: [...configDefaults.exclude, 'tests/smoke/**'] },
});
