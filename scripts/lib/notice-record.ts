/**
 * The step-2 check (design §2): a release's `announcedAt` (N) and `announcedProofAt` (B) are the
 * ones its readback record on the attestations branch proves, and they leave the 30-day notice
 * before it takes effect. The record and its three bodies are read as first committed, from the
 * branch history; the proof is read from the working tree, since upgrading one rewrites it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { checkTimestamp, type BitcoinBlock } from '@/lib/index/attestation';
import { effectiveAt, noticeBound } from '@/lib/index/calendar';
import { sha256Hex } from '@/lib/index/json';
import type { Methodology } from '@/lib/index/methodology';
import {
	jsonOf,
	readbackBodyNames,
	readbackRecordName,
	readbackRecordProblems,
	readbackSchema,
} from '@/lib/notice-readback';
import { OtsFormatError, readOtsProof } from '@/lib/ots';

import { firstCommittedFiles, type BranchCheckout } from './attestations';

export type NoticeVerdict =
	/** Nothing to check: the release is not announced. */
	| { kind: 'not_announced' }
	| { kind: 'verified'; noticeAt: string; proofAt: string; bound: string }
	/** Everything else holds, but the proof has not reached a Bitcoin block yet. */
	| { kind: 'pending'; calendars: string[] }
	| { kind: 'invalid'; problems: string[] };

/**
 * Checks `release`'s announcement against its readback record (design §2, step 2):
 * - the record and its three bodies are as first committed, and each body matches its hash;
 * - the record replays (`readbackRecordProblems`), and its N is the registry's `announcedAt`;
 * - its proof commits to the record's first-committed bytes and reaches an existing Bitcoin block,
 *   whose header time B is the registry's `announcedProofAt`;
 * - `effectiveAt(release) ≥ max(N, B) + 30 × 24 h`.
 * `releases` is the registry `release` is in, which fixes when it takes effect.
 */
export async function verifyNotice(
	checkout: BranchCheckout,
	release: Methodology,
	releases: readonly Methodology[],
	blockAt: (height: number) => Promise<BitcoinBlock>,
): Promise<NoticeVerdict> {
	const { announcedAt, announcedProofAt } = release;
	if (announcedAt === null) {
		return announcedProofAt === null
			? { kind: 'not_announced' }
			: { kind: 'invalid', problems: [`announcedProofAt is ${announcedProofAt} without N`] };
	}
	const { version } = release.parameters;
	const recordName = readbackRecordName(version);
	const bodyNames = Object.values(readbackBodyNames(version)).map((name) => `notices/${name}`);
	const wanted = new Set([recordName, ...bodyNames]);
	const { files, problems } = firstCommittedFiles(
		checkout,
		`notices/${version}.readback.*`,
		(name) => wanted.has(name),
	);
	const recordBytes = files.get(recordName);
	if (recordBytes === undefined) {
		return { kind: 'invalid', problems: [...problems, `${recordName} is not on the branch`] };
	}
	const parsed = readbackSchema.safeParse(jsonOf(recordBytes));
	if (!parsed.success) {
		return {
			kind: 'invalid',
			problems: [...problems, `${recordName} fails its schema: ${z.prettifyError(parsed.error)}`],
		};
	}
	const record = parsed.data;
	problems.push(...readbackRecordProblems(record, release).map((p) => `${recordName}: ${p}`));
	for (const response of record.responses) {
		const name = `notices/${response.body}`;
		const body = files.get(name);
		if (body === undefined) problems.push(`${name} is not on the branch`);
		else if (sha256Hex(body) !== response.bodySha256)
			problems.push(`${name} does not match the hash ${recordName} gives it`);
	}
	if (announcedAt !== record.noticeAt) {
		problems.push(`announcedAt is ${announcedAt}; the record's N is ${record.noticeAt}`);
	}

	const takesEffect = effectiveAt(release, releases);
	const proofPath = `${checkout.directory}/${recordName}.ots`;
	if (!existsSync(proofPath))
		return { kind: 'invalid', problems: [...problems, `${proofPath} does not exist`] };
	let proof;
	try {
		proof = readOtsProof(new Uint8Array(await readFile(proofPath)));
	} catch (error) {
		if (!(error instanceof OtsFormatError)) throw error;
		return {
			kind: 'invalid',
			problems: [...problems, `${proofPath} is not a valid proof: ${error.message}`],
		};
	}
	// A block at or after the release takes effect can never satisfy the bound: refused here, and
	// any earlier block is held to the bound below.
	const timestamp = await checkTimestamp(takesEffect, recordBytes, proof, blockAt);
	if (timestamp.kind === 'invalid') {
		return { kind: 'invalid', problems: [...problems, `${proofPath}: ${timestamp.problem}`] };
	}
	if (timestamp.kind === 'pending') {
		return problems.length > 0
			? { kind: 'invalid', problems }
			: { kind: 'pending', calendars: timestamp.calendars };
	}
	const proofAt = timestamp.time.toISOString();
	if (announcedProofAt !== proofAt) {
		problems.push(
			`announcedProofAt is ${String(announcedProofAt)}; the proof's Bitcoin block ${timestamp.height} has time ${proofAt}`,
		);
	}
	const bound = noticeBound(new Date(record.noticeAt), timestamp.time);
	if (takesEffect < bound) {
		problems.push(
			`${version} takes effect at ${takesEffect.toISOString()}, before max(N, B) + 30 days = ${bound.toISOString()}`,
		);
	}
	if (problems.length > 0) return { kind: 'invalid', problems };
	return { kind: 'verified', noticeAt: record.noticeAt, proofAt, bound: bound.toISOString() };
}
