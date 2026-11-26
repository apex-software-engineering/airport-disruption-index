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
 * Every attestation ever committed for a date, as first committed, with a problem for each later
 * modification or deletion of one. Each commit is diffed against its first parent, so a merge
 * cannot hide a rewrite or a deletion.
 */
export function readPins(
	checkout: BranchCheckout,
	date: UtcDate,
): { pins: Pin[]; problems: string[] } {
	const { directory } = checkout;
	if (!requireBranchCheckout(checkout)) return { pins: [], problems: [] };
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
		`${date}.r*.json`,
	]).toString();
	const pattern = new RegExp(`^${date}\\.r([1-9]\\d*)\\.json$`);
	const firstAdded = new Map<string, string>();
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
	checkout: BranchCheckout,
	date: UtcDate,
): Promise<string[]> {
	return verifyAttestedDay(await fetchDay(baseUrl, date), checkout);
}

/** What the attestations branch shows about one served revision of a day. */
export type RevisionProof = { revision: number } & (
	| { kind: 'unattested'; path: string }
	| { kind: 'proven'; pin: Pin; height: number; time: Date; cutoff: Date }
	/** Attested, but its time is not provable yet: the proof has not reached a Bitcoin block. */
	| { kind: 'pending'; pin: Pin; detail: string }
	/** Attested, but its proof is missing, malformed, wrong, or timestamped after its cutoff. */
	| { kind: 'invalid'; pin: Pin; detail: string }
);

/**
 * Every served revision of a day against the attestations branch. `problems` are conflicts, which
 * no proof can make good: a pin rewritten, deleted or merged in, a pinned revision the API no longer
 * serves, or an attestation its print contradicts. `revisions` says, per served revision, whether
 * it is attested and what its proof shows against that revision's own cutoff.
 */
export async function proveRevisions(
	{ print, revisions }: SettledDay,
	checkout: BranchCheckout,
): Promise<{ problems: string[]; revisions: RevisionProof[] }> {
	const { directory } = checkout;
	const { pins, problems } = readPins(checkout, print.date);
	problems.push(
		...pinProblems(
			pins.map((pin) => pin.attestation),
			revisions,
		),
	);
	if (problems.length > 0) return { problems, revisions: [] };
	const proofs: RevisionProof[] = [];
	for (const served of revisions) {
		const { revision } = served;
		const pin = pins.find((candidate) => candidate.revision === revision);
		if (pin === undefined) {
			proofs.push({
				revision,
				kind: 'unattested',
				path: attestationPath(directory, print.date, revision),
			});
			continue;
		}
		const proofPath = `${directory}/${pin.name}.ots`;
		if (!existsSync(proofPath)) {
			proofs.push({ revision, kind: 'invalid', pin, detail: `${proofPath} does not exist` });
			continue;
		}
		let proof;
		try {
			proof = readOtsProof(new Uint8Array(await readFile(proofPath)));
		} catch (error) {
			if (!(error instanceof OtsFormatError)) throw error;
			proofs.push({
				revision,
				kind: 'invalid',
				pin,
				detail: `${proofPath} is not a valid proof: ${error.message}`,
			});
			continue;
		}
		const verdict = await checkTimestamp(publicationCutoff(served), pin.bytes, proof, fetchBlock);
		if (verdict.kind === 'invalid') {
			proofs.push({ revision, kind: 'invalid', pin, detail: `${proofPath}: ${verdict.problem}` });
		} else if (verdict.kind === 'pending') {
			const detail = `${proofPath} is pending at ${verdict.calendars.join(', ')}`;
			proofs.push({ revision, kind: 'pending', pin, detail });
		} else {
			proofs.push({ revision, pin, ...verdict });
		}
	}
	return { problems, revisions: proofs };
}

/**
 * verifyAttested for a day already fetched, so a caller can attest from the same response:
 * verify-attestation's verdict on the live print, from `proveRevisions`.
 */
export async function verifyAttestedDay(
	day: SettledDay,
	checkout: BranchCheckout,
): Promise<string[]> {
	const { problems, revisions } = await proveRevisions(day, checkout);
	if (problems.length > 0) return problems;
	const live = revisions.find((proof) => proof.revision === day.print.revision);
	if (live === undefined) throw new Error(`r${day.print.revision} is not among its own revisions`);
	if (live.kind === 'unattested') {
		throw new Unattested(
			`the live print for ${day.print.date} is revision ${live.revision}; ${live.path} is not on the branch`,
		);
	}
	const pending: string[] = [];
	for (const proof of revisions) {
		if (proof.kind === 'unattested') continue;
		const { attestation, name } = proof.pin;
		console.log(
			`attestation ${name}: printHash ${attestation.printHash}, deployedCommit ${attestation.deployedCommit ?? 'unknown'}`,
		);
		if (proof.kind === 'invalid') problems.push(proof.detail);
		else if (proof.kind === 'pending') pending.push(proof.detail);
		else
			console.log(
				`timestamp: Bitcoin block ${proof.height} at ${proof.time.toISOString()}, before the cutoff ${proof.cutoff.toISOString()}`,
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
