/**
 * Reads an OpenTimestamps proof (a detached `.ots` file): the file digest it commits to, and the
 * attestations its operation tree reaches. Only what attestation checks need: a Bitcoin
 * attestation is reported with the merkle root its block must have, so a caller can check the
 * block against any source of block headers. Format: python-opentimestamps, `core/serialize.py`,
 * `core/timestamp.py`, `core/op.py` and `core/notary.py`.
 */
import { createHash } from 'node:crypto';

const MAGIC = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const MAX_DEPTH = 256;
const MAX_ARGUMENT_BYTES = 4096;
/** Every operation's result is capped, as python-opentimestamps does, so no proof can blow up. */
const MAX_RESULT_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 8192;
const BITCOIN_TAG = '0588960d73d71901';
const PENDING_TAG = '83dfe30d2ef90c8e';

export type OtsAttestation =
	| { kind: 'bitcoin'; height: number; merkleRoot: string }
	| { kind: 'pending'; calendarUrl: string }
	| { kind: 'unknown'; tag: string };

export type OtsProof = { fileSha256: string; attestations: OtsAttestation[] };

export class OtsFormatError extends Error {}

const HASHES: Record<number, string> = { 0x02: 'sha1', 0x03: 'ripemd160', 0x08: 'sha256' };
const APPEND = 0xf0;
const PREPEND = 0xf1;
const REVERSE = 0xf2;
const HEXLIFY = 0xf3;
const FORK = 0xff;
const ATTESTATION = 0x00;

class Reader {
	private offset = 0;
	constructor(private readonly bytes: Uint8Array) {}

	byte(): number {
		const value = this.bytes[this.offset];
		if (value === undefined) throw new OtsFormatError('proof ends early');
		this.offset += 1;
		return value;
	}

	take(length: number): Uint8Array {
		if (this.offset + length > this.bytes.length) throw new OtsFormatError('proof ends early');
		const slice = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return slice;
	}

	varuint(): number {
		let value = 0;
		for (let shift = 0; ; shift += 7) {
			if (shift > 49) throw new OtsFormatError('varuint too large');
			const byte = this.byte();
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) return value;
		}
	}

	varbytes(max: number): Uint8Array {
		const length = this.varuint();
		if (length > max) throw new OtsFormatError(`length ${length} exceeds ${max}`);
		return this.take(length);
	}

	atEnd(): boolean {
		return this.offset === this.bytes.length;
	}
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function readOtsProof(bytes: Uint8Array): OtsProof {
	const reader = new Reader(bytes);
	if (!Buffer.from(reader.take(MAGIC.length)).equals(MAGIC)) {
		throw new OtsFormatError('not an OpenTimestamps proof');
	}
	const version = reader.varuint();
	if (version !== 1) throw new OtsFormatError(`unsupported proof version ${version}`);
	const fileHashTag = reader.byte();
	if (fileHashTag !== 0x08) throw new OtsFormatError('proof does not commit to a sha256 digest');
	const digest = reader.take(32);
	const attestations: OtsAttestation[] = [];
	readTimestamp(reader, digest, attestations, 0);
	if (!reader.atEnd()) throw new OtsFormatError('trailing bytes after the proof');
	return { fileSha256: hex(digest), attestations };
}

function readTimestamp(
	reader: Reader,
	message: Uint8Array,
	attestations: OtsAttestation[],
	depth: number,
): void {
	if (depth > MAX_DEPTH) throw new OtsFormatError('proof nests too deeply');
	let tag = reader.byte();
	while (tag === FORK) {
		readBranch(reader, reader.byte(), message, attestations, depth);
		tag = reader.byte();
	}
	readBranch(reader, tag, message, attestations, depth);
}

function readBranch(
	reader: Reader,
	tag: number,
	message: Uint8Array,
	attestations: OtsAttestation[],
	depth: number,
): void {
	if (tag === ATTESTATION) {
		attestations.push(readAttestation(reader, message));
		return;
	}
	const result = applyOp(reader, tag, message);
	if (result.length > MAX_RESULT_BYTES)
		throw new OtsFormatError(`an operation's result exceeds ${MAX_RESULT_BYTES} bytes`);
	readTimestamp(reader, result, attestations, depth + 1);
}

function applyOp(reader: Reader, tag: number, message: Uint8Array): Uint8Array {
	const hash = HASHES[tag];
	if (hash !== undefined) return createHash(hash).update(message).digest();
	switch (tag) {
		case APPEND:
			return Buffer.concat([message, reader.varbytes(MAX_ARGUMENT_BYTES)]);
		case PREPEND:
			return Buffer.concat([reader.varbytes(MAX_ARGUMENT_BYTES), message]);
		case REVERSE:
			return Buffer.from(message).reverse();
		case HEXLIFY:
			return Buffer.from(hex(message), 'ascii');
		default:
			throw new OtsFormatError(`unsupported operation 0x${tag.toString(16)}`);
	}
}

function readAttestation(reader: Reader, message: Uint8Array): OtsAttestation {
	const tag = hex(reader.take(8));
	const payload = new Reader(reader.varbytes(MAX_PAYLOAD_BYTES));
	if (tag === BITCOIN_TAG) {
		if (message.length !== 32) throw new OtsFormatError('Bitcoin attestation on a non-digest');
		// Block explorers show the merkle root byte-reversed, as python-bitcoinlib's b2lx does.
		return {
			kind: 'bitcoin',
			height: payload.varuint(),
			merkleRoot: hex(Buffer.from(message).reverse()),
		};
	}
	if (tag === PENDING_TAG) {
		return {
			kind: 'pending',
			calendarUrl: new TextDecoder().decode(payload.varbytes(1000)),
		};
	}
	return { kind: 'unknown', tag };
}
