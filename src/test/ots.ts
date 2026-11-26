import { createHash } from 'node:crypto';

import { BITCOIN_TAG, PENDING_TAG } from '@/lib/ots';

const HEADER = Buffer.from(
	'004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e8929401',
	'hex',
);

/**
 * A minimal proof: the file's sha256, then one attestation directly on it. A Bitcoin attestation
 * on the bare digest means the block's merkle root must be that digest, byte-reversed.
 * `extraPayload` appends bytes inside the attestation's payload.
 */
export function syntheticProof(
	file: Uint8Array,
	attestation: { kind: 'bitcoin'; height: number } | { kind: 'pending'; calendarUrl: string },
	extraPayload: readonly number[] = [],
): { proof: Uint8Array; merkleRoot: string } {
	const digest = createHash('sha256').update(file).digest();
	const fields =
		attestation.kind === 'bitcoin'
			? [...varuint(attestation.height)]
			: [...varbytes(Buffer.from(attestation.calendarUrl))];
	const payload = [...fields, ...extraPayload];
	const tag = attestation.kind === 'bitcoin' ? BITCOIN_TAG : PENDING_TAG;
	const proof = new Uint8Array([
		...HEADER,
		0x08,
		...digest,
		0x00,
		...Buffer.from(tag, 'hex'),
		...varbytes(new Uint8Array(payload)),
	]);
	return { proof, merkleRoot: Buffer.from(digest).reverse().toString('hex') };
}

/**
 * A proof with several attestations, each directly on the file's sha256, as forks: what a proof
 * upgraded from several calendars looks like. Every Bitcoin attestation's block needs the same
 * merkle root, the digest byte-reversed.
 */
export function syntheticProofs(
	file: Uint8Array,
	attestations: readonly (
		{ kind: 'bitcoin'; height: number } | { kind: 'pending'; calendarUrl: string }
	)[],
): { proof: Uint8Array; merkleRoot: string } {
	const digest = createHash('sha256').update(file).digest();
	const branches = attestations.map((attestation, index) => {
		const fields =
			attestation.kind === 'bitcoin'
				? varuint(attestation.height)
				: varbytes(Buffer.from(attestation.calendarUrl));
		const tag = attestation.kind === 'bitcoin' ? BITCOIN_TAG : PENDING_TAG;
		const fork = index < attestations.length - 1 ? [0xff] : [];
		return [...fork, 0x00, ...Buffer.from(tag, 'hex'), ...varbytes(new Uint8Array(fields))];
	});
	const proof = new Uint8Array([...HEADER, 0x08, ...digest, ...branches.flat()]);
	return { proof, merkleRoot: Buffer.from(digest).reverse().toString('hex') };
}

function varuint(value: number): number[] {
	const bytes: number[] = [];
	let rest = value;
	do {
		const low = rest & 0x7f;
		rest = Math.floor(rest / 128);
		bytes.push(rest > 0 ? low | 0x80 : low);
	} while (rest > 0);
	return bytes;
}

function varbytes(bytes: Uint8Array): number[] {
	return [...varuint(bytes.length), ...bytes];
}
