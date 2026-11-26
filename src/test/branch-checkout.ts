import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

import type { BranchCheckout } from '../../scripts/lib/attestations';

/** A new empty directory, removed when the current test finishes. */
export function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** Files to write (or, for null, remove) by path relative to the checkout. */
export type Files = Record<string, string | Uint8Array | null>;

/**
 * A git repo standing in for a checkout of the attestations branch. Each commit also moves
 * origin/attestations to it, as a fetch would.
 */
export function branchCheckout() {
	const directory = temporaryDirectory('adi-attestations-');
	const checkout: BranchCheckout = { directory, branch: 'attestations' };
	const git = (...args: string[]) =>
		execFileSync(
			'git',
			[
				'-C',
				directory,
				'-c',
				'user.name=t',
				'-c',
				'user.email=t@t',
				'-c',
				'commit.gpgsign=false',
				...args,
			],
			{ stdio: 'ignore' },
		);
	const apply = (files: Files) => {
		for (const [name, content] of Object.entries(files)) {
			if (content === null) {
				git('rm', '--quiet', name);
				continue;
			}
			mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
			writeFileSync(path.join(directory, name), content);
		}
		git('add', '--all');
	};
	const publish = () => git('update-ref', 'refs/remotes/origin/attestations', 'HEAD');
	git('init', '--quiet', '--initial-branch=work');
	return {
		checkout,
		git,
		commit(files: Files) {
			apply(files);
			git('commit', '--quiet', '-m', 'commit');
			publish();
		},
		/** A merge whose own commit also applies `inMerge`, which a plain log would not show. */
		evilMerge(files: Files) {
			git('switch', '--quiet', '-c', 'side');
			apply({ 'side.txt': 'side' });
			git('commit', '--quiet', '-m', 'side');
			git('switch', '--quiet', 'work');
			git('merge', '--quiet', '--no-ff', '--no-commit', 'side');
			apply(files);
			git('commit', '--quiet', '-m', 'merge');
			publish();
		},
	};
}
