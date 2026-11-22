import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * The day math is handed its release and window; it must never look either up (design §2). Every
 * spelling of the modules is covered (`./calendar`, `@/lib/index/calendar`, `../index/calendar`),
 * named, namespace and re-export forms alike, and dynamic import() is refused outright.
 */
const INJECTED = 'The release and day are resolved at the entry point and passed in.';
const LOOKUPS = [
	{ group: ['**/releases'], message: INJECTED },
	{
		group: ['**/methodology'],
		importNames: [
			'activeReleases',
			'methodologyOf',
			'settlementReleaseFor',
			'settlementReleaseOrNull',
		],
		message: INJECTED,
	},
	{
		group: ['**/calendar'],
		importNames: ['collectingRelease', 'dayAt', 'settlementDay'],
		message: INJECTED,
	},
];

export default defineConfig([
	...nextVitals,
	...nextTs,
	{
		files: ['src/lib/index/day.ts', 'src/lib/index/print.ts'],
		rules: {
			'no-restricted-imports': ['error', { patterns: LOOKUPS }],
			'no-restricted-syntax': [
				'error',
				{ selector: 'ImportExpression', message: `No dynamic import() here. ${INJECTED}` },
			],
		},
	},
	globalIgnores(['.next/**', '.vercel/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts']),
]);
