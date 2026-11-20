import { parseRoundId } from '@/lib/index/time';
import { readRaw, readReceipt } from '@/server/archive';
import { json, problem, untrustedBytes } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { roundCache } from '@/server/views';

export const dynamic = 'force-dynamic';

/** The response body exactly as received; its sha256 is the receipt's rawSha256. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	if (parseRoundId(id) === null) return problem(400, `invalid round id ${id}`);
	const store = storeFromEnv();
	const receipt = await readReceipt(store, id);
	if (receipt === null) return problem(404, `no round ${id}`);
	const raw = await readRaw(store, receipt);
	// Only an invalid receipt has no body, and a valid retry can still replace it: same cache rule.
	if (raw === null)
		return json({ error: `round ${id} received no response body` }, roundCache(receipt), 404);
	const contentType = receipt.httpStatus === 200 ? 'application/xml' : 'application/octet-stream';
	return untrustedBytes(raw, contentType, roundCache(receipt));
}
