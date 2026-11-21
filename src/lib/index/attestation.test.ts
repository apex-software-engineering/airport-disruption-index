import { describe, expect, it } from 'vitest';

import { readOtsProof } from '@/lib/ots';
import { feedFixture, otsFixture } from '@/test/fixtures';

import {
	attestationProblems,
	buildAttestation,
	checkTimestamp,
	pinProblems,
	publicationCutoff,
	roundsDigest,
	serializeAttestation,
} from './attestation';
import { sha256Hex } from './json';
import { CURRENT_ADAPTER } from './adapters';
import { methodologyFor } from './methodology';
import { buildPrint } from './print';
import { summarizeReceipt } from './round';
import { collectedReceipt } from '@/test/receipts';
import { attestationSchema } from './schemas';

const raw = feedFixture('synthetic-gs-gdp.xml');
const receipts = ['2026-11-17T20:45:02.123Z', '2026-11-17T20:50:01.500Z'].map((at) =>
	collectedReceipt({
		fetchedAt: new Date(at),
		sourceUrl: CURRENT_ADAPTER.url,
		outcome: { kind: 'response', httpStatus: 200, body: raw },
	}),
);
const print = buildPrint('2026-11-17', receipts.map(summarizeReceipt), { revision: 1 });
const commit = 'a'.repeat(40);

describe('roundsDigest', () => {
	it('hashes the listed receipt hashes in print order, newline-joined', () => {
		const [first, second] = print.rounds;
		expect(roundsDigest(print)).toBe(sha256Hex(`${first?.receiptHash}\n${second?.receiptHash}`));
	});
});

describe('buildAttestation', () => {
	it('pins the print and passes its own schema', () => {
		const attestation = buildAttestation(print, commit);
		expect(attestationSchema.parse(attestation)).toEqual({
			schema: 'adi.attestation/1',
			date: '2026-11-17',
			revision: 1,
			printHash: print.printHash,
			roundsDigest: roundsDigest(print),
			parameterHash: methodologyFor('2026-11-17').parameterHash,
			methodologyVersion: methodologyFor('2026-11-17').parameters.version,
			deployedCommit: commit,
		});
	});

	it('records an unknown deployed commit as null', () => {
		expect(buildAttestation(print, null).deployedCommit).toBeNull();
	});
});

describe('attestationProblems', () => {
	const attestation = buildAttestation(print, commit);

	it('matches the print it was built from', () => {
		expect(attestationProblems(attestation, print)).toEqual([]);
	});

	it('ignores the deployed commit, which later deploys change', () => {
		expect(attestationProblems({ ...attestation, deployedCommit: null }, print)).toEqual([]);
	});

	it('flags a print rebuilt with different rounds, even with a valid hash', () => {
		const rewritten = buildPrint('2026-11-17', receipts.slice(0, 1).map(summarizeReceipt), {
			revision: 1,
		});
		expect(attestationProblems(attestation, rewritten)).toEqual([
			expect.stringMatching(/^printHash: print has /),
			expect.stringMatching(/^roundsDigest: print has /),
		]);
	});

	it('flags a print edited without recomputing its hash', () => {
		const edited = { ...print, rounds: print.rounds.slice(0, 1) };
		expect(attestationProblems(attestation, edited)).toEqual([
			'printHash does not match the print contents',
			expect.stringMatching(/^roundsDigest: print has /),
		]);
	});
});

describe('serializeAttestation', () => {
	it('writes the 2026-11-20 r1 attestation byte for byte as already stamped', () => {
		// Published in f16303f and stamped 2026-11-21T16:24Z; the format is frozen to these bytes.
		const text = serializeAttestation({
			schema: 'adi.attestation/1',
			date: '2026-11-20',
			revision: 1,
			printHash: '84523089bc2fc90ddc3ab0cf9b3a9378742f3dba1b41fc23f2675cac86ab67bf',
			roundsDigest: 'fa9ba1997a77f33990604616ec506f82424c2af2273e719d9bb29b815645d034',
			parameterHash: 'e9ef6e94b84699bffefa850b78138355bb427563f6ae42a28567e0ec4303c363',
			methodologyVersion: '1.0.0',
			deployedCommit: null,
		});
		expect(sha256Hex(text)).toBe(
			'51f255c64e16237ed62c917189b4104bd1ac55c0c3b794e10bc58c6e755ca6c2',
		);
		expect(text).toBe(new TextDecoder().decode(otsFixture('pending.json')));
	});
});

describe('pinProblems', () => {
	const pin = buildAttestation(print, commit);

	it('accepts pins that match the revisions served', () => {
		expect(pinProblems([pin], [print])).toEqual([]);
	});

	it('rejects a pinned revision the API no longer serves, as a rollback would', () => {
		expect(pinProblems([pin, { ...pin, revision: 2 }], [print])).toEqual([
			'revision 2 is attested but the API no longer serves it',
		]);
	});

	it('rejects a served revision that conflicts with its pin', () => {
		const other = buildPrint('2026-11-17', receipts.slice(0, 1).map(summarizeReceipt), {
			revision: 1,
		});
		expect(pinProblems([pin], [other])).toEqual([
			expect.stringMatching(/^r1: printHash: print has /),
			expect.stringMatching(/^r1: roundsDigest: print has /),
		]);
	});
});

describe('publicationCutoff', () => {
	it('is the start of D+2 in UTC for revision 1', () => {
		expect(publicationCutoff({ date: '2026-11-20', revision: 1 })?.toISOString()).toBe(
			'2026-11-22T00:00:00.000Z',
		);
		expect(publicationCutoff({ date: '2026-12-31', revision: 1 })?.toISOString()).toBe(
			'2027-01-02T00:00:00.000Z',
		);
	});

	it('is 48 hours after issuedAt for a correction', () => {
		expect(
			publicationCutoff({ date: '2026-11-20', revision: 2, issuedAt: '2026-11-25T10:00:00Z' }),
		).toEqual(new Date('2026-11-27T10:00:00Z'));
	});

	it('is unknown for a correction without issuedAt, and rejects a malformed one', () => {
		expect(publicationCutoff({ date: '2026-11-20', revision: 2 })).toBeNull();
		expect(() =>
			publicationCutoff({ date: '2026-11-20', revision: 2, issuedAt: 'yesterday' }),
		).toThrow(/not an instant/);
	});
});

describe('checkTimestamp', () => {
	// The OpenTimestamps example proof: Bitcoin block 358391, mined 2015-05-28T15:41:18Z.
	const file = otsFixture('hello-world.txt');
	const proof = readOtsProof(otsFixture('hello-world.txt.ots'));
	const block358391 = {
		merkleRoot: '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00',
		time: new Date('2015-05-28T15:41:18Z'),
	};
	const cutoff = (date: string) => {
		const at = publicationCutoff({ date, revision: 1 });
		if (at === null) throw new Error('revision 1 always has a cutoff');
		return at;
	};
	const explorer = async (height: number) => {
		if (height !== 358391) throw new Error(`unexpected block ${height}`);
		return block358391;
	};

	it('proves a time before the cutoff', async () => {
		expect(await checkTimestamp(cutoff('2015-05-27'), file, proof, explorer)).toEqual({
			kind: 'proven',
			height: 358391,
			time: block358391.time,
			cutoff: new Date('2015-05-29T00:00:00Z'),
		});
	});

	it('fails a proof timestamped after the cutoff, as a rewrite would be', async () => {
		const verdict = await checkTimestamp(cutoff('2015-05-25'), file, proof, explorer);
		expect(verdict).toEqual({
			kind: 'invalid',
			problem: expect.stringMatching(/after the publication cutoff 2015-05-27T00:00:00.000Z$/),
		});
	});

	it('fails a block whose merkle root is not the one the proof needs', async () => {
		const verdict = await checkTimestamp(cutoff('2015-05-27'), file, proof, async () => ({
			...block358391,
			merkleRoot: '0'.repeat(64),
		}));
		expect(verdict).toEqual({ kind: 'invalid', problem: expect.stringMatching(/merkle root/) });
	});

	it('fails a proof for different bytes', async () => {
		const verdict = await checkTimestamp(
			cutoff('2015-05-27'),
			otsFixture('pending.json'),
			proof,
			explorer,
		);
		expect(verdict).toEqual({
			kind: 'invalid',
			problem: 'the proof does not commit to this attestation file',
		});
	});

	it('reports a pending proof with its calendars, without a time', async () => {
		const verdict = await checkTimestamp(
			cutoff('2026-11-20'),
			otsFixture('pending.json'),
			readOtsProof(otsFixture('pending.json.ots')),
			explorer,
		);
		expect(verdict.kind).toBe('pending');
		expect(verdict.kind === 'pending' && verdict.calendars).toHaveLength(4);
	});
});
