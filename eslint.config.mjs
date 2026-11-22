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
	{
		group: ['**/indicative'],
		importNames: [
			'dueIndicativeDays',
			'indicativeAdmissionFor',
			'indicativeReleaseFor',
			'indicativeReleaseIn',
		],
		message: INJECTED,
	},
];

export default defineConfig([
	...nextVitals,
	...nextTs,
	{
		// `const { field, ...rest } = value` is how a field is dropped; the dropped name is unused.
		rules: { '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }] },
	},
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
