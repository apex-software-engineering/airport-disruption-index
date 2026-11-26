import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { collectingRelease, effectiveAt, upcomingRelease } from '@/lib/index/calendar';
import { CACHE, DEPLOYED_COMMIT, json } from '@/server/http';

/**
 * The methodology in effect now, the source adapter collecting now, and during a notice period
 * the upcoming release (design §5). An adapter
 * fix can change the address fetched without a methodology release, so `parameters.source` is
 * the source as of the release; each receipt records the address it fetched.
 */
export function GET() {
	const now = new Date();
	const { parameters, parameterHash } = collectingRelease(now);
	const upcoming = upcomingRelease(now);
	return json(
		{
			version: parameters.version,
			parameterHash,
			parameterHashAlgorithm:
				'sha256 of the canonical JSON (sorted keys, no whitespace) of parameters',
			deployedCommit: DEPLOYED_COMMIT,
			parameters,
			activeAdapter: { version: CURRENT_ADAPTER.version, url: CURRENT_ADAPTER.url },
			/** A release whose notice is published but which is not in effect yet; null otherwise. */
			upcoming:
				upcoming === null
					? null
					: {
							version: upcoming.parameters.version,
							parameterHash: upcoming.parameterHash,
							effectiveFrom: upcoming.effectiveFrom,
							effectiveAt: effectiveAt(upcoming).toISOString(),
							announcedAt: upcoming.announcedAt,
						},
			notes: {
				'parameters.source':
					'the source as of this release (hashed); the address fetched now is activeAdapter.url, and each receipt records its own sourceUrl and adapterVersion',
			},
		},
		// Short-lived, so the `upcoming` block appears with the rest of a notice, at its instant.
		CACHE.live,
	);
}
