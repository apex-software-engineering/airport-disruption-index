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

import type { SettledDay } from '@/lib/reproduce';

import { CannotVerify, Pending, Unattested, fetchDay, getPublic } from './public-api';

export const DEFAULT_DIRECTORY = 'attestations';
export const DEFAULT_BRANCH = 'attestations';

/** Where the publication branch is checked out, and which branch it must be. */
export type BranchCheckout = { directory: string; branch: string };
const BLOCK_EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'];

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

/**
 * A block's merkle root and time from a public block explorer (Esplora API): mempool.space, or
 * blockstream.info when it cannot answer, so one explorer's outage never stops a check. Each
 * request has the client's total deadline (`fetchWhole`).
 */
export async function fetchBlock(height: number): Promise<BitcoinBlock> {
	const failures: string[] = [];
	for (const base of BLOCK_EXPLORERS) {
		try {
			return await fetchBlockFrom(base, height);
		} catch (error) {
			if (!(error instanceof CannotVerify)) throw error;
			failures.push(error.message);
		}
	}
	throw new CannotVerify(`no block explorer answered for block ${height}: ${failures.join('; ')}`);
}

async function fetchBlockFrom(base: string, height: number): Promise<BitcoinBlock> {
	const explorer = async (path: string) => {
		const url = `${base}${path}`;
		const response = await getPublic(url).catch((error: unknown) => {
			if (error instanceof CannotVerify) throw error;
			throw new CannotVerify(`GET ${url} failed: ${String(error)}`);
		});
		if (!response.ok) throw new CannotVerify(`GET ${url}: HTTP ${response.status}`);
		return response;
	};
	const hash = (await (await explorer(`/block-height/${height}`)).text()).trim();
	const block = z
		.object({ height: z.literal(height), merkle_root: z.string(), timestamp: z.number().int() })
		.safeParse(await (await explorer(`/block/${hash}`)).json().catch(() => null));
	if (!block.success) throw new CannotVerify(`${base} answered block ${height} unreadably`);
	return { merkleRoot: block.data.merkle_root, time: new Date(block.data.timestamp * 1000) };
}

export type Pin = { revision: number; name: string; attestation: Attestation; bytes: Uint8Array };

function git(directory: string, args: string[]): Buffer {
	return execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitOf(directory: string, ref: string): string | null {
	try {
		return git(directory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
			.toString()
			.trim();
	} catch {
		return null;
	}
}

/**
 * Checks the directory is the root of a full checkout whose HEAD is the tip of origin/{branch},
 * so its history is the published one. Returns false when nothing is published yet.
 */
function requireBranchCheckout({ directory, branch }: BranchCheckout): boolean {
	let root = '';
	try {
		root = git(directory, ['rev-parse', '--show-toplevel']).toString().trim();
	} catch {
		// not a git checkout: reported below
	}
	if (!existsSync(directory) || root !== realpathSync(directory)) {
		throw new CannotVerify(
			`${directory}/ is not a checkout of the ${branch} branch; see docs/methodology.md, Attestations`,
		);
	}
	if (git(directory, ['rev-parse', '--is-shallow-repository']).toString().trim() === 'true')
		throw new CannotVerify(`${directory}/ is a shallow checkout, whose history is incomplete`);
	const head = commitOf(directory, 'HEAD');
	const tip = commitOf(directory, `refs/remotes/origin/${branch}`);
	const update = `run git fetch origin && git -C ${directory} checkout --detach origin/${branch}`;
	if (head === null && tip === null) {
		// Nothing here. Unpublished only if there is no remote, or the remote has no such branch.
		if (!hasOrigin(directory)) return false;
		const live = liveTip(directory, branch);
		if (live === 'missing') return false;
		throw new CannotVerify(
			live === null
				? `could not reach origin to check whether ${branch} is published`
				: `fetch first: origin has ${branch} at ${live}, which this checkout lacks; ${update}`,
		);
	}
	if (head !== tip) {
		throw new CannotVerify(
			`${directory}/ is at ${head ?? 'no commit'}, not origin/${branch} (${tip ?? 'missing'}); ${update}`,
		);
	}
	const live = liveTip(directory, branch);
	if (live === null) {
		console.warn(
			`warning: could not reach origin to check ${branch} is current; this checks the branch as of your last fetch`,
		);
	} else if (live !== head) {
		throw new CannotVerify(
			`stale checkout, fetch first: origin has ${branch} at ${live}; ${update}`,
		);
	}
	return true;
}

function hasOrigin(directory: string): boolean {
	try {
		git(directory, ['remote', 'get-url', 'origin']);
		return true;
	} catch {
		return false;
	}
}

/**
 * The branch tip on the remote right now: a commit, 'missing' when the remote has no such
 * branch, or null when the remote cannot be reached.
 */
function liveTip(directory: string, branch: string): string | null {
	try {
		const output = git(directory, ['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
		const [sha] = output.toString().split('\t');
		return sha === undefined ? 'missing' : sha.trim();
	} catch (error) {
		// ls-remote --exit-code exits 2 when it reached the remote and found no matching ref.
		if (error instanceof Error && 'status' in error && error.status === 2) return 'missing';
		return null;
	}
}

/**
 * Every file under `pathspec` (with a name `accept` takes) ever committed to the publication
 * branch, as first committed, with a problem for each later modification or deletion of one and
 * for any merge commit. Each commit is diffed against its first parent, so a merge cannot hide a
 * rewrite or a deletion. The one reader of the branch's history.
 */
export function firstCommittedFiles(
	checkout: BranchCheckout,
	pathspec: string,
	accept: (name: string) => boolean,
): { files: Map<string, Uint8Array>; problems: string[] } {
	const { directory } = checkout;
	if (!requireBranchCheckout(checkout)) return { files: new Map(), problems: [] };
	// The branch ruleset requires linear history; a merge commit anywhere means it was bypassed,
	// and a first-parent walk alone could then miss what the merged side changed.
	const problems = git(directory, ['rev-list', '--merges', 'HEAD'])
		.toString()
		.split('\n')
		.filter((sha) => sha !== '')
		.map((sha) => `publication history contains merge commit ${sha}; it must be linear`);
	const log = git(directory, [
		'log',
		'--reverse',
		'--first-parent',
		'--diff-merges=first-parent',
		'--no-renames',
		'--format=commit %H',
		'--name-status',
		'--',
		pathspec,
	]).toString();
	const firstAdded = new Map<string, string>();
	let commit = '';
	for (const line of log.split('\n')) {
		if (line.startsWith('commit ')) commit = line.slice('commit '.length);
		const [status, name] = line.split('\t');
		if (status === undefined || name === undefined || !accept(name)) continue;
		if (status === 'A' && !firstAdded.has(name)) firstAdded.set(name, commit);
		else problems.push(`${name} was ${status === 'D' ? 'deleted' : 'modified'} in ${commit}`);
	}
	const files = new Map<string, Uint8Array>();
	for (const [name, added] of firstAdded) {
		files.set(name, new Uint8Array(git(directory, ['show', `${added}:${name}`])));
	}
	return { files, problems };
}

/**
 * Every attestation ever committed for a date, as first committed, with a problem for each later
 * modification or deletion of one (`firstCommittedFiles`).
 */
export function readPins(
	checkout: BranchCheckout,
	date: UtcDate,
): { pins: Pin[]; problems: string[] } {
	const pattern = new RegExp(`^${date}\\.r([1-9]\\d*)\\.json$`);
	const { files, problems } = firstCommittedFiles(checkout, `${date}.r*.json`, (name) =>
		pattern.test(name),
	);
	const pins: Pin[] = [];
	for (const [name, bytes] of files) {
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
	checkout: BranchCheckout,
	date: UtcDate,
): Promise<string[]> {
	return verifyAttestedDay(await fetchDay(baseUrl, date), checkout);
}

/** verifyAttested for a day already fetched, so a caller can attest from the same response. */
export async function verifyAttestedDay(
	{ print, revisions }: SettledDay,
	checkout: BranchCheckout,
): Promise<string[]> {
	const { directory } = checkout;
	const date = print.date;
	const { pins, problems } = readPins(checkout, date);
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

/** The attestation files (`{date}.r{revision}.json`) in a directory. */
export async function attestationNames(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter((name) =>
		/^\d{4}-\d{2}-\d{2}\.r[1-9]\d*\.json$/.test(name),
	);
}

/**
 * Offline check of the named attestations' proofs, whatever their dates: each must exist, parse,
 * and commit to its attestation file. A pending proof passes. Returns one entry per bad proof.
 */
export async function invalidProofs(
	directory: string,
	names: readonly string[],
): Promise<{ name: string; problem: string }[]> {
	const invalid: { name: string; problem: string }[] = [];
	for (const name of names) {
		const path = `${directory}/${name}`;
		if (!existsSync(path)) {
			invalid.push({ name, problem: `${path}.ots has no attestation file beside it` });
			continue;
		}
		if (!existsSync(`${path}.ots`)) {
			invalid.push({ name, problem: `${path}.ots does not exist` });
			continue;
		}
		try {
			const proof = readOtsProof(new Uint8Array(await readFile(`${path}.ots`)));
			if (proof.fileSha256 !== sha256Hex(new Uint8Array(await readFile(path))))
				invalid.push({ name, problem: `${path}.ots does not commit to ${path}` });
		} catch (error) {
			if (!(error instanceof OtsFormatError)) throw error;
			invalid.push({ name, problem: `${path}.ots is not a valid proof: ${error.message}` });
		}
	}
	return invalid;
}
