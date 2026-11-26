import { CACHE, cronAuthorized, json, problem } from '@/server/http';
import { httpStatusOf, runSettle } from '@/server/settle-run';
import { storeFromEnv } from '@/server/storage';
import { dayWindow, dueSettlementDays, settlesAt } from '@/lib/index/calendar';
import { settlementReleaseOrNull } from '@/lib/index/methodology';
import { parseUtcDate } from '@/lib/index/time';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron (vercel.json, design §3): 00:30Z with retries at 00:45Z and 01:00Z for v1's UTC days,
 * and 04:30Z (EDT) or 05:30Z (EST) with retries 15 and 30 minutes later for ET days, each run
 * ending before the day's publication deadline.
 *
 * Without `?date`, every settlement day whose cutoff passed in the last 48 hours is attempted, each
 * independently: one that fails or is blocked never stops another. `already_settled` repoints the
 * history at the latest revision; `nothing_due` means no day was due. `?date=YYYY-MM-DD` settles
 * that past day at any age (the operator's recovery path), and refuses it before its cutoff.
 *
 * Every authorized run also freezes the indicative ET days (design §4) of the last few dates whose
 * freeze time has passed, whatever the settlements do.
 *
 * Every day's whole attempt and every freeze runs concurrently under its own deadline
 * (src/server/settle-run.ts), so a stalled storage request fails only its own attempt.
 *
 * The status is 500 when any day failed, else 409 when any was blocked (its print key holds
 * something else, reported as `misfiled` and never overwritten), else 200.
 */
export async function GET(request: Request) {
	if (!cronAuthorized(request)) return problem(401, 'unauthorized');
	const now = new Date();
	const store = storeFromEnv();
	const named = new URL(request.url).searchParams.get('date');
	if (named === null) {
		const due = dueSettlementDays(now).map(({ window }) => window.date);
		const { settled, indicative } = await runSettle(store, now, due);
		const status = settled.length === 0 ? 'nothing_due' : 'ran';
		return json({ status, settled, indicative }, CACHE.none, httpStatusOf(settled));
	}
	if (parseUtcDate(named) === null) return problem(400, `invalid date ${named}`);
	const release = settlementReleaseOrNull(named);
	if (release === null)
		return problem(400, `no methodology is in effect on ${named}, so it has nothing to settle`);
	const cutoff = settlesAt(dayWindow(release, named));
	if (now < cutoff) return problem(409, `${named} settles at ${cutoff.toISOString()}`);
	const { settled, indicative } = await runSettle(store, now, [named]);
	const [day] = settled;
	if (day === undefined) throw new Error(`runSettle returned no outcome for ${named}`);
	return json({ ...day, indicative }, CACHE.none, httpStatusOf(settled));
}
