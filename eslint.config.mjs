import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/** The day math is handed its release and window; it must never look either up (design §2). */
const INJECTED = 'The release and day are resolved at the entry point and passed in.';
const LOOKUPS = [
	{ name: './releases', message: INJECTED },
	{ name: '@/lib/index/releases', message: INJECTED },
	...['./methodology', '@/lib/index/methodology'].map((name) => ({
		name,
		importNames: [
			'activeReleases',
			'methodologyOf',
			'settlementReleaseFor',
			'settlementReleaseOrNull',
		],
		message: INJECTED,
	})),
	...['./calendar', '@/lib/index/calendar'].map((name) => ({
		name,
		importNames: ['collectingRelease', 'dayAt', 'settlementDay'],
		message: INJECTED,
	})),
];

export default defineConfig([
	...nextVitals,
	...nextTs,
	{
		files: ['src/lib/index/day.ts', 'src/lib/index/print.ts'],
		rules: { 'no-restricted-imports': ['error', { paths: LOOKUPS }] },
	},
	globalIgnores(['.next/**', '.vercel/**', 'out/**', 'build/**', 'coverage/**', 'next-env.d.ts']),
]);
