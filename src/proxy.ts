import { NextResponse } from 'next/server';

import { INDICATIVE_UNPUBLISHED, indicativeSeriesPublished } from '@/lib/index/indicative';
import { problem } from '@/server/http';

/**
 * The one gate in front of the indicative API: before the series' notice is published, every
 * request under /api/v1/indicative, whatever its method (GET, HEAD, OPTIONS, …), is a 404 before
 * any route handler runs.
 */
export function proxy(): Response {
	return indicativeSeriesPublished() ? NextResponse.next() : problem(404, INDICATIVE_UNPUBLISHED);
}

export const config = { matcher: ['/api/v1/indicative', '/api/v1/indicative/:path*'] };
