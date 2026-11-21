/**
 * Issues a correction print for a settled day: the operator's only way to change a published
 * print (docs/methodology.md, settlement rule 8). Run against the store named by the environment;
 * README.md#corrections shows how to load it from Vercel without printing the token.
 *
 *   npm run correct -- <YYYY-MM-DD> --supersedes <printHash> --reason "<text>"
 *     [--override-window "<justification>"]   required after the corrections window, refused before
 *
 * Exit codes: 0 written, 1 refused or failed (the message says whether anything was written), 2 usage.
 */
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { parseUtcDate } from '@/lib/index/time';
import { correctDay, type CorrectionRequest } from '@/server/archive';
import { storeFromEnv } from '@/server/storage';

const USAGE =
	'usage: npm run correct -- <YYYY-MM-DD> --supersedes <printHash> --reason "<text>" [--override-window "<justification>"]';

function parse(argv: string[]): { date: string; request: CorrectionRequest } | null {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			supersedes: { type: 'string' },
			reason: { type: 'string' },
			'override-window': { type: 'string' },
		},
	});
	const [date, ...rest] = positionals;
	const { supersedes, reason } = values;
	if (date === undefined || rest.length > 0 || parseUtcDate(date) === null) return null;
	if (supersedes === undefined || reason === undefined) return null;
	return {
		date,
		request: {
			supersedesPrintHash: supersedes,
			reason,
			windowOverride: values['override-window'] ?? null,
		},
	};
}

/** Names the store without its credentials, and refuses to guess one. */
function target(env: NodeJS.ProcessEnv): string | null {
	if (env.ADI_DATA_DIR) return `filesystem store ${env.ADI_DATA_DIR}`;
	if (env.VERCEL_ENV) return `Vercel Blob, VERCEL_ENV=${env.VERCEL_ENV}`;
	return null;
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
	const store = target(process.env);
	if (store === null) {
		console.error(
			'Set ADI_DATA_DIR, or VERCEL_ENV and BLOB_READ_WRITE_TOKEN (README.md#corrections).',
		);
		return 2;
	}
	console.log(`store: ${store}`);
	try {
		const print = await correctDay(storeFromEnv(), args.date, args.request, new Date());
		const { result } = print;
		console.log(
			`wrote ${print.date} r${print.revision}: ${result.status}${result.status === 'suspended' ? '' : `, ADI ${result.value}`}, ${print.rounds.length} rounds`,
		);
		console.log(`printHash ${print.printHash}`);
		console.log(`supersedes ${args.request.supersedesPrintHash}`);
		return 0;
	} catch (error) {
		const message =
			error instanceof z.ZodError
				? z.prettifyError(error)
				: error instanceof Error
					? error.message
					: String(error);
		console.error(`correction failed: ${message}`);
		return 1;
	}
}

void main().then((code) => {
	process.exitCode = code;
});
