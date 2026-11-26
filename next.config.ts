import { execFileSync } from 'node:child_process';
import type { NextConfig } from 'next';

import { DEPLOYED_COMMIT_HEADER, parseDeployedCommit, UNKNOWN_COMMIT } from './src/lib/deployment';

/**
 * The commit this build is made from, or 'unknown'. A Vercel git build checks out the commit
 * itself. Otherwise the build reads the local checkout, and only a clean one: a modified or
 * untracked file means the code is not that commit. A Vercel CLI upload has no .git and builds
 * remotely, so it is 'unknown'; deploy with `vercel build` + `vercel deploy --prebuilt`.
 */
function deployedCommit(): string {
	const fromVercelGit = process.env.VERCEL_GIT_COMMIT_SHA;
	if (fromVercelGit) return fromVercelGit;
	const git = (...args: string[]) =>
		execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	try {
		return git('status', '--porcelain') === '' ? git('rev-parse', 'HEAD') : UNKNOWN_COMMIT;
	} catch {
		return UNKNOWN_COMMIT; // no git, or not a checkout
	}
}

const commit = deployedCommit();
parseDeployedCommit(commit); // fails the build on anything but a full commit id or 'unknown'

const nextConfig: NextConfig = {
	// Always inlined, so the running code never reads a runtime variable of this name.
	env: { DEPLOYED_COMMIT: commit },
	// Pages name their commit too (the API sets it per response, src/server/http.ts), so the notice
	// readback records which deployment served the incidents page it read (design §2).
	headers: async () => [
		{
			source: '/((?!api/).*)',
			headers: [{ key: DEPLOYED_COMMIT_HEADER, value: commit }],
		},
	],
};

export default nextConfig;
