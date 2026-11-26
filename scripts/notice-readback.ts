/**
 * Reads a methodology notice back from the public site and, once the incidents entry, the
 * methodology page's rules and the `upcoming` block all show it, writes the single write-once
 * record `notices/{version}.readback.json` and its three bodies into the attestations checkout
 * (design §2). Run by the notice-readback workflow, which then
 * stamps and publishes it.
 *
 *   npm run notice-readback -- <version> --run-id <id> --run-started-at <ISO> [--dir attestations] [--base-url URL]
 *
 * Exit 0 when the record is written, or already exists (it is never rewritten); 3 when the notice
 * is not public yet (nothing is written; run again later), including before the release's notice
 * instant (`noticePublishedAt`, unset or not reached); 1 when the site states the release wrongly; 2 when the
 * check could not run.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isNoticePublished } from '@/lib/index/methodology';
import { RELEASES } from '@/lib/index/releases';
import { READBACK_ORIGIN, readBackNotice, readbackRecordName } from '@/lib/notice-readback';
import { Mismatch } from '@/lib/reproduce';

import { DEFAULT_DIRECTORY } from './lib/attestations';
import { CannotVerify, describeError, getPublicNoRedirect, parseArgs } from './lib/public-api';

const USAGE =
	'npm run notice-readback -- <version> --run-id <id> --run-attempt <n> --run-started-at <ISO> [--dir attestations]';

async function main(): Promise<number> {
	const {
		target: version,
		baseUrl,
		options,
	} = parseArgs(process.argv.slice(2), USAGE, ['run-id', 'run-attempt', 'run-started-at', 'dir']);
	const release = RELEASES.find((candidate) => candidate.parameters.version === version);
	if (release === undefined) throw new CannotVerify(`no registered release is ${version}`);
	if (baseUrl !== READBACK_ORIGIN) {
		throw new CannotVerify(`a readback record is only for ${READBACK_ORIGIN}, never ${baseUrl}`);
	}
	if (!isNoticePublished(release, new Date())) {
		console.log(
			`${version}: its notice is not published yet (noticePublishedAt ${release.noticePublishedAt ?? 'unset'}); nothing to read back`,
		);
		return 3;
	}
	const id = Number(options.get('run-id'));
	const attempt = Number(options.get('run-attempt'));
	const startedAt = new Date(options.get('run-started-at') ?? '');
	const positive = (value: number) => Number.isInteger(value) && value > 0;
	if (!positive(id) || !positive(attempt) || Number.isNaN(startedAt.getTime()))
		throw new CannotVerify(
			`--run-id, --run-attempt and --run-started-at are required; usage: ${USAGE}`,
		);
	const path = `${options.get('dir') ?? DEFAULT_DIRECTORY}/${readbackRecordName(version)}`;
	const directory = dirname(path);
	if (existsSync(path)) {
		console.log(`${path} already exists; a readback record is never rewritten`);
		return 0;
	}
	// The public internet, never the preview bypass: N is when anyone could read the notice.
	const readback = await readBackNotice(
		READBACK_ORIGIN,
		release,
		{ id, attempt, startedAt },
		() => new Date(),
		getPublicNoRedirect,
	);
	if (readback.kind === 'not_public') {
		for (const reason of readback.reasons) console.log(`not public yet: ${reason}`);
		return 3;
	}
	await mkdir(directory, { recursive: true });
	// The bodies first, the record last: a record on disk always has its bodies beside it.
	for (const { name, bytes } of readback.bodies)
		await writeFile(`${directory}/${name}`, bytes, { flag: 'wx' });
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
