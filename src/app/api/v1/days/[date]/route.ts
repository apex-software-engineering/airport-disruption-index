import { settlementReleaseOrNull } from '@/lib/index/methodology';
import { parseUtcDate } from '@/lib/index/time';
import { CACHE, json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { dayView } from '@/server/views';

export const dynamic = 'force-dynamic';

/**
 * A day's settlement print and every revision. A contract that pins a parameter hash passes it as
 * `?parameterHash=`; when the release that owns the day has another hash, the response is a
 * machine-readable `parameter_hash_mismatch` 404 naming both and the owning release, and no print.
 */
export async function GET(request: Request, context: { params: Promise<{ date: string }> }) {
	const { date } = await context.params;
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	const release = settlementReleaseOrNull(date);
	if (release === null)
		return problem(404, `no methodology is in effect on ${date}, so it has no print`);
	const pinned = new URL(request.url).searchParams.get('parameterHash');
	if (pinned !== null && pinned !== release.parameterHash) {
		return json(
			{
				problem: 'parameter_hash_mismatch',
				date,
				expected: pinned,
				actual: release.parameterHash,
				release: {
					version: release.parameters.version,
					parameterHash: release.parameterHash,
					effectiveFrom: release.effectiveFrom,
					effectiveUntil: release.effectiveUntil,
				},
			},
			CACHE.live,
			404,
		);
	}
	const view = await dayView(storeFromEnv(), date);
	// Short-lived even when settled: a correction can replace the latest revision at any time.
	return json(view, CACHE.live, view.status === 'settled' ? 200 : 404);
}
