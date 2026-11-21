/**
 * Attestation files on the `attestations` branch, checked out at `attestations/` in the repo root
 * (npm runs scripts there): `{date}.r{revision}.json` and its OpenTimestamps proof `.json.ots`.
 * A file is written once and never rewritten: its exact bytes are what the proof commits to. A
 * verifier reads each attestation as first committed, from the branch history, not the working
 * tree; proofs are read from the working tree, since upgrading one rewrites it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import {
	CORRECTION_STAMP_HOURS,
	checkTimestamp,
	pinProblems,
	publicationCutoff,
	serializeAttestation,
	type BitcoinBlock,
} from '@/lib/index/attestation';
import { sha256Hex } from '@/lib/index/json';
import { attestationSchema, type Attestation } from '@/lib/index/schemas';
import type { UtcDate } from '@/lib/index/time';
import { OtsFormatError, readOtsProof } from '@/lib/ots';

import { CannotVerify, Pending, Unattested, fetchDay, getPublic } from './public-api';

export const DEFAULT_DIRECTORY = 'attestations';
const BLOCK_EXPLORER = 'https://mempool.space/api';

export function attestationPath(directory: string, date: UtcDate, revision: number): string {
	return `${directory}/${date}.r${revision}.json`;
}

/** Fails if the file already exists: an attestation is never rewritten. */
export async function writeAttestation(
	directory: string,
	attestation: Attestation,
): Promise<string> {
	const path = attestationPath(directory, attestation.date, attestation.revision);
	await mkdir(directory, { recursive: true });
	await writeFile(path, serializeAttestation(attestation), { flag: 'wx' });
	return path;
}

/** A block's merkle root and time from a public block explorer (Esplora API). */
export async function fetchBlock(height: number): Promise<BitcoinBlock> {
	const explorer = async (path: string) => {
		const url = `${BLOCK_EXPLORER}${path}`;
		const response = await getPublic(url).catch((error: unknown) => {
			throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
		});
		if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
		return response;
	};
	const hash = (await (await explorer(`/block-height/${height}`)).text()).trim();
	const block = z
		.object({ height: z.literal(height), merkle_root: z.string(), timestamp: z.number().int() })
		.parse(await (await explorer(`/block/${hash}`)).json());
	return { merkleRoot: block.merkle_root, time: new Date(block.timestamp * 1000) };
}

export type Pin = { revision: number; name: string; attestation: Attestation; bytes: Uint8Array };

function git(directory: string, args: string[]): Buffer {
	return execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Every attestation ever committed for a date, as first committed, with a problem for each later
 * modification or deletion of one. The directory must be the root of a checkout of the branch.
 */
export function readPins(directory: string, date: UtcDate): { pins: Pin[]; problems: string[] } {
	let root: string;
	try {
		root = git(directory, ['rev-parse', '--show-toplevel']).toString().trim();
	} catch {
		root = '';
	}
	if (!existsSync(directory) || root !== realpathSync(directory)) {
		throw new CannotVerify(
			`${directory}/ is not a checkout of the attestations branch; see docs/methodology.md, Attestations`,
		);
	}
	try {
		git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD']);
	} catch {
		return { pins: [], problems: [] }; // nothing published yet
	}
	const log = git(directory, [
		'log',
		'--reverse',
		'--no-renames',
		'--format=commit %H',
		'--name-status',
		'--',
		`${date}.r*.json`,
	]).toString();
	const pattern = new RegExp(`^${date}\\.r([1-9]\\d*)\\.json$`);
	const firstAdded = new Map<string, string>();
	const problems: string[] = [];
	let commit = '';
	for (const line of log.split('\n')) {
		if (line.startsWith('commit ')) commit = line.slice('commit '.length);
		const [status, name] = line.split('\t');
		if (status === undefined || name === undefined || !pattern.test(name)) continue;
		if (status === 'A' && !firstAdded.has(name)) firstAdded.set(name, commit);
		else problems.push(`${name} was ${status === 'D' ? 'deleted' : 'modified'} in ${commit}`);
	}
	const pins: Pin[] = [];
	for (const [name, added] of firstAdded) {
		const bytes = new Uint8Array(git(directory, ['show', `${added}:${name}`]));
		const parsed = attestationSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
		const revision = Number(pattern.exec(name)?.[1]);
		if (!parsed.success) {
			problems.push(`${name} fails its schema: ${z.prettifyError(parsed.error)}`);
		} else if (parsed.data.date !== date || parsed.data.revision !== revision) {
			problems.push(`${name} attests ${parsed.data.date} r${parsed.data.revision}`);
		} else {
			pins.push({ revision, name, attestation: parsed.data, bytes });
		}
	}
	return { pins, problems };
}

/**
 * Checks a date's live revisions against every attestation pinned for it, then each pin's
 * timestamp against its cutoff. Returns the problems found. Throws Unattested when the current
 * print has no attestation, and Pending when everything matches but a proof has not reached a
 * Bitcoin block yet.
 */
export async function verifyAttested(
	baseUrl: string,
	directory: string,
	date: UtcDate,
): Promise<string[]> {
	const { print, revisions } = await fetchDay(baseUrl, date);
	const { pins, problems } = readPins(directory, date);
	problems.push(
		...pinProblems(
			pins.map((pin) => pin.attestation),
			revisions,
		),
	);
	if (problems.length > 0) return problems;
	if (!pins.some((pin) => pin.revision === print.revision)) {
		throw new Unattested(
			`the live print for ${date} is revision ${print.revision}; ${attestationPath(directory, date, print.revision)} is not on the branch`,
		);
	}
	const pending: string[] = [];
	for (const pin of pins) {
		const { attestation } = pin;
		console.log(
			`attestation ${pin.name}: printHash ${attestation.printHash}, deployedCommit ${attestation.deployedCommit ?? 'unknown'}`,
		);
		const served = revisions.find((r) => r.revision === pin.revision);
		if (served === undefined) throw new Error(`pinProblems lets r${pin.revision} through unserved`);
		const cutoff = publicationCutoff(served);
		if (cutoff === null) {
			throw new CannotVerify(
				`${pin.name} attests a correction; its cutoff is ${CORRECTION_STAMP_HOURS} hours after the print's correction.issuedAt, which it does not record (#10)`,
			);
		}
		const proofPath = `${directory}/${pin.name}.ots`;
		if (!existsSync(proofPath)) {
			problems.push(`${proofPath} does not exist`);
			continue;
		}
		let proof;
		try {
			proof = readOtsProof(new Uint8Array(await readFile(proofPath)));
		} catch (error) {
			if (!(error instanceof OtsFormatError)) throw error;
			problems.push(`${proofPath} is not a valid proof: ${error.message}`);
			continue;
		}
		const verdict = await checkTimestamp(cutoff, pin.bytes, proof, fetchBlock);
		if (verdict.kind === 'invalid') problems.push(`${proofPath}: ${verdict.problem}`);
		else if (verdict.kind === 'pending')
			pending.push(`${proofPath} is pending at ${verdict.calendars.join(', ')}`);
		else
			console.log(
				`timestamp: Bitcoin block ${verdict.height} at ${verdict.time.toISOString()}, before the cutoff ${verdict.cutoff.toISOString()}`,
			);
	}
	if (problems.length > 0) return problems;
	if (pending.length > 0) {
		throw new Pending(
			`the print matches its attestation, but its time is not yet provable: ${pending.join('; ')}. Run ots upgrade later.`,
		);
	}
	return [];
}

/**
 * Offline check of every proof in the directory, whatever its date: it must parse and commit to
 * its attestation file. Returns the problems; a pending proof is not one. `skip` lists files
 * written this run, which the workflow stamps afterwards.
 */
export async function invalidProofs(
	directory: string,
	skip: ReadonlySet<string>,
): Promise<string[]> {
	const names = (await readdir(directory)).filter((name) => /\.r\d+\.json$/.test(name));
	const problems: string[] = [];
	for (const name of names) {
		const path = `${directory}/${name}`;
		if (skip.has(path)) continue;
		if (!existsSync(`${path}.ots`)) {
			problems.push(`${path}.ots does not exist`);
			continue;
		}
		try {
			const proof = readOtsProof(new Uint8Array(await readFile(`${path}.ots`)));
			if (proof.fileSha256 !== sha256Hex(new Uint8Array(await readFile(path))))
				problems.push(`${path}.ots does not commit to ${path}`);
		} catch (error) {
			if (!(error instanceof OtsFormatError)) throw error;
			problems.push(`${path}.ots is not a valid proof: ${error.message}`);
		}
	}
	return problems;
}
