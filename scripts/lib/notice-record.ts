/**
 * The step-2 check (design §2): a release's `announcedAt` (N), `announcedProofAt` (B) and
 * `announcedProofHeight` are the ones its readback record on the attestations branch proves, and
 * they leave the 30-day notice before it takes effect. The record and its three bodies are read as
 * first committed, from the branch history; the proof is read from the working tree, since
 * upgrading one rewrites it. Nothing in the record is taken on trust: anyone with write access can
 * push to the branch, so the record's timing and its saved pages are replayed as the readback
 * checked them.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { checkTimestamp, type BitcoinBlock } from '@/lib/index/attestation';
import { effectiveAt, noticeBound } from '@/lib/index/calendar';
import { sha256Hex } from '@/lib/index/json';
import type { Methodology } from '@/lib/index/methodology';
import {
	READBACK_ORIGIN,
	jsonOf,
	noticeBodyProblems,
	readbackBodyNames,
	readbackRecordName,
	readbackRecordProblems,
	readbackSchema,
	type NoticeBodies,
} from '@/lib/notice-readback';
import { OtsFormatError, readOtsProof, type OtsProof } from '@/lib/ots';

import { committedVersions, firstCommittedFiles, type BranchCheckout } from './attestations';

export type NoticeVerdict =
	/** Nothing to check: the release is not announced. */
	| { kind: 'not_announced' }
	| { kind: 'verified'; noticeAt: string; proofAt: string; proofHeight: number; bound: string }
	/** Everything else holds, but the proof has not reached a Bitcoin block yet. */
	| { kind: 'pending'; calendars: string[] }
	| { kind: 'invalid'; problems: string[] };

/** How a registry instant must be written: exactly as `toISOString` writes it. */
const ISO_FORM =
	'an ISO instant with milliseconds, as the record writes it (e.g. 2026-11-29T00:20:05.000Z)';

/**
 * Checks the announcement of release `version` in `releases` against its readback record (design
 * §2, step 2):
 * - the record and its three bodies are as first committed, and each body matches its hash;
 * - the record replays (`readbackRecordProblems`: order, chronology, `Date` windows, N at or after
 *   the notice instant), and its N is the registry's `announcedAt`;
 * - its bodies show the notice (`noticeBodyProblems`): the dated headline, announcing an effective
 *   day no later than the registry's, with the release's hash; its rules heading; its `upcoming`
 *   block;
 * - its proof commits to the record's first-committed bytes and has an attestation in the
 *   registry's `announcedProofHeight` block, an existing block whose header time B is the
 *   registry's `announcedProofAt`;
 * - `effectiveAt(release) ≥ max(N, B) + 30 × 24 h`, from the release's place in `releases`.
 */
export async function verifyNotice(
	checkout: BranchCheckout,
	version: string,
	releases: readonly Methodology[],
	blockAt: (height: number) => Promise<BitcoinBlock>,
): Promise<NoticeVerdict> {
	const release = releases.find((candidate) => candidate.parameters.version === version);
	if (release === undefined) {
		return { kind: 'invalid', problems: [`no registered release is ${version}`] };
	}
	const { announcedAt, announcedProofAt, announcedProofHeight } = release;
	if (announcedAt === null) {
		return announcedProofAt === null && announcedProofHeight === null
			? { kind: 'not_announced' }
			: { kind: 'invalid', problems: [`${version} has a proof time or height without N`] };
	}
	const recordName = readbackRecordName(version);
	const names = readbackBodyNames(version);
	const path = (name: string) => `notices/${name}`;
	const wanted = new Set([recordName, ...Object.values(names).map(path)]);
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
	problems.push(
		...readbackRecordProblems(record, release, READBACK_ORIGIN).map((p) => `${recordName}: ${p}`),
	);
	const bodyOf = (name: string): Uint8Array | null => {
		const body = files.get(path(name));
		const hashed = record.responses.find((response) => response.body === name)?.bodySha256;
		if (body === undefined) problems.push(`${path(name)} is not on the branch`);
		else if (sha256Hex(body) !== hashed)
			problems.push(`${path(name)} does not match the hash ${recordName} gives it`);
		else return body;
		return null;
	};
	const incidents = bodyOf(names.incidents);
	const rules = bodyOf(names.rules);
	const methodology = bodyOf(names.methodology);
	if (incidents !== null && rules !== null && methodology !== null) {
		const bodies: NoticeBodies = { incidents, rules, methodology };
		// A postponement (design §7) keeps the record: the day it announced may be earlier than the
		// registry's, never later.
		problems.push(
			...noticeBodyProblems(
				release,
				READBACK_ORIGIN,
				bodies,
				(day) => day <= release.effectiveFrom,
			),
		);
	}
	if (announcedAt !== record.noticeAt) {
		problems.push(
			`announcedAt is ${announcedAt}; it must be the record's N, ${record.noticeAt} (${ISO_FORM})`,
		);
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
	// B is the earliest Bitcoin block of the first committed version of the proof that reached one
	// (design §2). A later upgrade may add an earlier block, or a higher one with an earlier header
	// time; neither moves B, and the registry pins its height.
	const reached = firstReachedBlock(committedVersions(checkout, `${recordName}.ots`), proof);
	if (reached === null) {
		const timestamp = await checkTimestamp(takesEffect, recordBytes, proof, blockAt);
		if (timestamp.kind === 'invalid')
			return { kind: 'invalid', problems: [...problems, `${proofPath}: ${timestamp.problem}`] };
		if (problems.length > 0) return { kind: 'invalid', problems };
		if (timestamp.kind === 'pending') return { kind: 'pending', calendars: timestamp.calendars };
		throw new Error(`${proofPath} reaches a block that firstReachedBlock did not find`);
	}
	if (announcedProofHeight !== null && announcedProofHeight !== reached.height) {
		problems.push(
			`announcedProofHeight is ${announcedProofHeight}, but the proof first reached Bitcoin block ${reached.height} (commit ${reached.commit}): B is that block's time`,
		);
	}
	const pinned = {
		...proof,
		attestations: proof.attestations.filter(
			(a) => a.kind === 'bitcoin' && a.height === reached.height,
		),
	};
	if (pinned.attestations.length === 0) {
		return {
			kind: 'invalid',
			problems: [
				...problems,
				`${proofPath} no longer has its attestation in Bitcoin block ${reached.height}, which it first reached in commit ${reached.commit}`,
			],
		};
	}
	// A block at or after the release takes effect can never satisfy the bound: refused here, and
	// any earlier block is held to the bound below.
	const timestamp = await checkTimestamp(takesEffect, recordBytes, pinned, blockAt);
	if (timestamp.kind === 'invalid') {
		return { kind: 'invalid', problems: [...problems, `${proofPath}: ${timestamp.problem}`] };
	}
	if (timestamp.kind === 'pending') throw new Error('a proof filtered to one block is not pending');
	const proofAt = timestamp.time.toISOString();
	if (announcedProofHeight === null || announcedProofAt !== proofAt) {
		problems.push(
			`announcedProofHeight and announcedProofAt are ${String(announcedProofHeight)} and ${String(announcedProofAt)}; they must be Bitcoin block ${timestamp.height} and its time ${proofAt} (${ISO_FORM})`,
		);
	}
	const bound = noticeBound(new Date(record.noticeAt), timestamp.time);
	if (takesEffect < bound) {
		problems.push(
			`${version} takes effect at ${takesEffect.toISOString()}, before max(N, B) + 30 days = ${bound.toISOString()}`,
		);
	}
	if (problems.length > 0) return { kind: 'invalid', problems };
	return {
		kind: 'verified',
		noticeAt: record.noticeAt,
		proofAt,
		proofHeight: timestamp.height,
		bound: bound.toISOString(),
	};
}

/**
 * The earliest Bitcoin block in the first committed version of a proof that reached one, and that
 * commit; for a proof never committed with a block, the current file's earliest (a local
 * checkout ahead of the branch). Null while the proof reaches no block.
 */
function firstReachedBlock(
	versions: readonly { commit: string; bytes: Uint8Array }[],
	current: OtsProof,
): { height: number; commit: string } | null {
	const earliest = (proof: OtsProof) =>
		Math.min(...proof.attestations.flatMap((a) => (a.kind === 'bitcoin' ? [a.height] : [])));
	for (const { commit, bytes } of versions) {
		let height;
		try {
			height = earliest(readOtsProof(bytes));
		} catch (error) {
			if (!(error instanceof OtsFormatError)) throw error;
			continue;
		}
		if (Number.isFinite(height)) return { height, commit };
	}
	const height = earliest(current);
	return Number.isFinite(height) ? { height, commit: 'working tree' } : null;
}
