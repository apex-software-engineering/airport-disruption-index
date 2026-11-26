/**
 * Reads a methodology notice back from the public site and, once both the incidents entry and the
 * `upcoming` block show it, writes the single write-once record `notices/{version}.readback.json`
 * into the attestations checkout (design §2). Run by the notice-readback workflow, which then
 * stamps and publishes it.
 *
 *   npm run notice-readback -- <version> --run-id <id> --run-started-at <ISO> [--dir attestations] [--base-url URL]
 *
 * Exit 0 when the record is written, or already exists (it is never rewritten); 3 when the notice
 * is not public yet (nothing is written; run again later), including before the release's notice
 * has shipped (`noticePublishedAt` null); 1 when the site states the release wrongly; 2 when the
 * check could not run.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import { RELEASES } from '@/lib/index/releases';
import { readBackNotice } from '@/lib/notice-readback';
import { Mismatch } from '@/lib/reproduce';

import { DEFAULT_DIRECTORY } from './lib/attestations';
import { CannotVerify, describeError, getPublic, parseArgs } from './lib/public-api';

const USAGE =
	'npm run notice-readback -- <version> --run-id <id> --run-started-at <ISO> [--dir attestations] [--base-url URL]';

async function main(): Promise<number> {
	const {
		target: version,
		baseUrl,
		options,
	} = parseArgs(process.argv.slice(2), USAGE, ['run-id', 'run-started-at', 'dir']);
	const release = RELEASES.find((candidate) => candidate.parameters.version === version);
	if (release === undefined) throw new CannotVerify(`no registered release is ${version}`);
	if (release.noticePublishedAt === null) {
		console.log(
			`${version}: its notice has not shipped (noticePublishedAt is null); nothing to read back`,
		);
		return 3;
	}
	const id = Number(options.get('run-id'));
	const startedAt = new Date(options.get('run-started-at') ?? '');
	if (!Number.isInteger(id) || id <= 0 || Number.isNaN(startedAt.getTime()))
		throw new CannotVerify(`--run-id and --run-started-at are required; usage: ${USAGE}`);
	const directory = `${options.get('dir') ?? DEFAULT_DIRECTORY}/notices`;
	const path = `${directory}/${version}.readback.json`;
	if (existsSync(path)) {
		console.log(`${path} already exists; a readback record is never rewritten`);
		return 0;
	}
	// The public internet, never the preview bypass: N is when anyone could read the notice.
	const readback = await readBackNotice(baseUrl, release, { id, startedAt }, getPublic);
	if (readback.kind === 'not_public') {
		for (const reason of readback.reasons) console.log(`not public yet: ${reason}`);
		return 3;
	}
	await mkdir(directory, { recursive: true });
	await writeFile(path, `${JSON.stringify(readback.record, null, '\t')}\n`, { flag: 'wx' });
	console.log(`wrote ${path}: ${version} public since ${readback.record.noticeAt} (N)`);
	return 0;
}

void main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`cannot read back: ${describeError(error)}`);
		process.exitCode = error instanceof Mismatch ? 1 : 2;
	},
);
