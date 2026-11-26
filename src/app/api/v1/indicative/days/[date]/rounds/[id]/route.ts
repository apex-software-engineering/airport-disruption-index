import { parseRoundId, parseUtcDate } from '@/lib/index/time';
import { readIndicativeRound } from '@/server/indicative-archive';
import { json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { roundCache } from '@/server/views';

export const dynamic = 'force-dynamic';

/**
 * A round as evidence for one frozen indicative print: served only if that print lists it, with
 * the hash it lists. This is the only place a receipt from a release this code does not know is
 * served (by shape and hash), because the indicative print listed it as foreign; the default
 * round endpoint never serves one.
 */
export async function GET(
	_request: Request,
	context: { params: Promise<{ date: string; id: string }> },
) {
	const { date, id } = await context.params;
	if (parseUtcDate(date) === null) return problem(400, `invalid date ${date}`);
	if (parseRoundId(id) === null) return problem(400, `invalid round id ${id}`);
	const receipt = await readIndicativeRound(storeFromEnv(), date, id);
	if (receipt === null) return problem(404, `the indicative print of ${date} lists no round ${id}`);
	return json(receipt, roundCache(receipt));
}
