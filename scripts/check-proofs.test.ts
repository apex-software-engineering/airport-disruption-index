import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { otsFixture } from '@/test/fixtures';

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe('check-proofs', () => {
	// The attest workflow publishes a file only on its OK line, so this output is a contract.
	it('prints OK for each good proof and INVALID for each bad one', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'adi-check-proofs-'));
		directories.push(directory);
		const write = (name: string, bytes: Uint8Array) =>
			writeFileSync(path.join(directory, name), bytes);
		write('2026-11-20.r1.json', otsFixture('pending.json'));
		write('2026-11-20.r1.json.ots', otsFixture('pending.json.ots'));
		write('2026-11-19.r1.json', otsFixture('pending.json'));
		write('2026-11-19.r1.json.ots', otsFixture('hello-world.txt.ots'));
		const run = spawnSync(
			'npx',
			['tsx', 'scripts/check-proofs.ts', directory, '2026-11-20.r1.json', '2026-11-19.r1.json'],
			{ encoding: 'utf8' },
		);
		expect(run.status).toBe(1);
		expect(run.stdout.split('\n')).toEqual(
			expect.arrayContaining([
				'OK 2026-11-20.r1.json',
				expect.stringMatching(/^INVALID 2026-11-19\.r1\.json: .*does not commit to/),
			]),
		);
		expect(run.stdout).not.toContain('OK 2026-11-19.r1.json');
	});
});
