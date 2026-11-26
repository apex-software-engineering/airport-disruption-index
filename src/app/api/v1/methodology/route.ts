import { CACHE, json } from '@/server/http';
import { methodologyView } from '@/server/views';

/** The methodology in effect now (methodologyView, design §5). */
export function GET() {
	// Short-lived, so the `upcoming` block appears with the rest of a notice, at its instant.
	return json(methodologyView(new Date()), CACHE.live);
}
