/** The lint guard that keeps the day math from looking up its own release. */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

const GUARDS = new Set(['no-restricted-imports', 'no-restricted-syntax']);

async function restrictedImports(filePath: string, source: string): Promise<number> {
	const [result] = await eslint.lintText(source, { filePath });
	return (result?.messages ?? []).filter((m) => m.ruleId !== null && GUARDS.has(m.ruleId)).length;
}

describe('day.ts and print.ts take their release as an argument', () => {
	it.each(['src/lib/index/day.ts', 'src/lib/index/print.ts'])(
		'refuses a release lookup imported into %s',
		async (filePath) => {
			const lookups = [
				"import { settlementDay } from './calendar';",
				"import { settlementReleaseFor } from './methodology';",
				"import { RELEASES } from './releases';",
				"import { dayAt } from '@/lib/index/calendar';",
				"import { collectingRelease } from '../index/calendar';",
				// Namespace and re-export forms reach every export, so they are refused too.
				"import * as calendar from './calendar';",
				"import * as methodology from '@/lib/index/methodology';",
				"export * from './calendar';",
				"export { settlementDay } from './calendar';",
				"const calendar = await import('./calendar');",
			];
			for (const line of lookups) {
				expect(await restrictedImports(filePath, `${line}\nexport const used = 1;\n`), line).toBe(
					1,
				);
			}
			const allowed =
				"import { dayWindow, settlesAt } from './calendar';\nexport const used = 1;\n";
			expect(await restrictedImports(filePath, allowed)).toBe(0);
		},
		60_000,
	);

	it('allows the same lookups in an entry point', async () => {
		const source =
			"import { settlementDay } from './calendar';\nexport const used = settlementDay;\n";
		expect(await restrictedImports('src/lib/index/verify.ts', source)).toBe(0);
	}, 60_000);
});
