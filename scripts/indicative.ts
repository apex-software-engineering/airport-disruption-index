/**
 * Freezes the indicative ET print of every day in a range whose freeze time has passed (design
 * §4), for the launch of the series and to catch up after missed settle runs. Each day is built
 * from archived receipts only, by the same code the settle route runs, and written once.
 *
 *   npm run indicative -- --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]   (--to defaults to yesterday, UTC)
 *
 * Exit codes: 0 every day frozen or already frozen, 1 some day failed (the others were still
 * attempted), 2 usage, or production before the series is published (rehearse on preview).
 */
import { parseArgs } from 'node:util';

import { indicativeReleaseFor, indicativeSeriesPublished } from '@/lib/index/indicative';
import { addDays, parseUtcDate, utcDateOf } from '@/lib/index/time';
import { freezeIndicativeDay } from '@/server/archive';
import { openStore, storeTarget, type ObjectStore } from '@/server/storage';

import { indicativeWriteRefusal } from './lib/indicative-target';

const USAGE = 'usage: npm run indicative -- --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]';

function parse(argv: string[]): { from: string; to: string } | null {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: { from: { type: 'string' }, to: { type: 'string' } },
	});
	const { from } = values;
	const to = values.to ?? addDays(utcDateOf(new Date()), -1);
	if (positionals.length > 0 || from === undefined) return null;
	if (parseUtcDate(from) === null || parseUtcDate(to) === null || from > to) return null;
	return { from, to };
}

async function main(): Promise<number> {
	let args: ReturnType<typeof parse>;
	try {
		args = parse(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		args = null;
	}
	if (args === null) {
		console.error(USAGE);
		return 2;
	}
	const target = storeTarget(process.env);
	if (target === null) {
		console.error(
			'Set ADI_DATA_DIR, or VERCEL_ENV and BLOB_READ_WRITE_TOKEN (README.md#corrections).',
		);
		return 2;
	}
	// One resolved target decides both whether to write and what to open.
	const refusal = indicativeWriteRefusal(target.target, indicativeSeriesPublished());
	if (refusal !== null) {
		console.error(refusal);
		return 2;
	}
	let store: ObjectStore;
	try {
		store = openStore(target.target, process.env); // validates the token and VERCEL_ENV
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (target.warning !== null) console.warn(`warning: ${target.warning}`);
	console.log(`store: ${target.name}`);
	let failed = 0;
	for (let date = args.from; date <= args.to; date = addDays(date, 1)) {
		if (indicativeReleaseFor(date) === null) {
			console.log(`${date}: no indicative day`);
			continue;
		}
		try {
			const { status, print } = await freezeIndicativeDay(store, date, new Date());
			const { result } = print;
			console.log(
				`${date} (ET, indicative): ${status}, ${result.status}${result.status === 'suspended' ? '' : `, ADI ${result.value}`}, printHash ${print.printHash}`,
			);
		} catch (error) {
			failed += 1;
			console.error(`${date}: failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return failed > 0 ? 1 : 0;
}

void main().then((code) => {
	process.exitCode = code;
});
