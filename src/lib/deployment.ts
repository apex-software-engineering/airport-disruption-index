/** How a deployment names the commit it was built from: a full commit id, or 'unknown'. */
const COMMIT = /^[0-9a-f]{40}$/;

export const UNKNOWN_COMMIT = 'unknown';
export const DEPLOYED_COMMIT_HEADER = 'X-Deployed-Commit';

/** A deployed-commit value as a commit id, or null for 'unknown'. Anything else is an error. */
export function parseDeployedCommit(value: string): string | null {
	if (value === UNKNOWN_COMMIT) return null;
	if (COMMIT.test(value)) return value;
	throw new Error(
		`deployed commit ${JSON.stringify(value)} is neither a full commit id nor '${UNKNOWN_COMMIT}'`,
	);
}
