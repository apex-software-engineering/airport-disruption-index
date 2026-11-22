import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { collectingRelease } from '@/lib/index/calendar';
import { CACHE, DEPLOYED_COMMIT, json } from '@/server/http';

/**
 * The methodology in effect now, and separately the source adapter collecting now. An adapter
 * fix can change the address fetched without a methodology release, so `parameters.source` is
 * the source as of the release; each receipt records the address it fetched.
 */
export function GET() {
	const { parameters, parameterHash } = collectingRelease(new Date());
	return json(
		{
			version: parameters.version,
			parameterHash,
			parameterHashAlgorithm:
				'sha256 of the canonical JSON (sorted keys, no whitespace) of parameters',
			deployedCommit: DEPLOYED_COMMIT,
			parameters,
			activeAdapter: { version: CURRENT_ADAPTER.version, url: CURRENT_ADAPTER.url },
			notes: {
				'parameters.source':
					'the source as of this release (hashed); the address fetched now is activeAdapter.url, and each receipt records its own sourceUrl and adapterVersion',
			},
		},
		CACHE.daily,
	);
}
