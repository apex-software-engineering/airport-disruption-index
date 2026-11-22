import { parseRoundId } from '@/lib/index/time';
import { readReceipt, UnrecognizedReceipt } from '@/server/archive';
import { json, problem } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { roundCache } from '@/server/views';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	if (parseRoundId(id) === null) return problem(400, `invalid round id ${id}`);
	const receipt = await readReceipt(storeFromEnv(), id).catch(unrecognized);
	if (receipt === 'unrecognized')
		return problem(422, `round ${id} is stored but cannot be validated`);
	if (receipt === null) return problem(404, `no round ${id}`);
	return json(receipt, roundCache(receipt));
}

/** A receipt this deployment cannot validate is a 422, not a crash; anything else still throws. */
function unrecognized(error: unknown): 'unrecognized' {
	if (error instanceof UnrecognizedReceipt) return 'unrecognized';
	throw error;
}
